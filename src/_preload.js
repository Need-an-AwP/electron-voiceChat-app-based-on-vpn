const { contextBridge, ipcRenderer } = require('electron')
const StreamVisualizer = require('../js/streamvisualizer')
const { TimelineDataSeries, TimelineGraphView } = require('../js/graph')
const AudioVisualizer = require('../js/AudioLevelVisualizer')
const NoiseModule = require('../js/noise')
const io = require('socket.io-client')



/*
contextBridge.exposeInMainWorld('socketExpose', {
    io: (url) => {
        const socket = io(url)
        return socket
    }
})
*/
const ctx_main = new AudioContext();
let localStream
let sourceNode
let gainNode
let gainNode1
let captureAudioSource
let destinationNode

let optionsList = []
let networkIds = []
let network_names = []
let ipHere = []
let ts_localIp
let ts_peersIp = []

const pendingIceCandidates = {}; //ice candidate buffer
let room_members = []
let localpcs = {}
let remotepcs = {}
let dc_ping = {}
let dc_renegotiation = {}
let dc_receive = {}
let target_server = ''
let signaling_statue = false
let ping_startTime
let ping_endTime
let rtc_ping_startTime
let rtc_ping_endTime
let rtc_latency
const connectionInfo = {
    localPCs: {},
    remotePCs: {}
}

let bitrateGraph;
let bitrateSeries;
let targetBitrateSeries;
let headerrateSeries;
let packetGraph;
let packetSeries;
let lastResult;

let bytesReceived = 0;
let bytesSent = 0;

let Module;
let frameBuffer = [];
var inputBuffer = [];
var outputBuffer = [];
var bufferSize = 1024;

function initializeNoiseSuppressionModule() {
    if (Module) {
        return;
    }
    Module = {
        noExitRuntime: true,
        noInitialRun: true,
        preInit: [],
        preRun: [],
        postRun: [
            function () {
                console.log(`Loaded Javascript Module OK`);
            },
        ],
        memoryInitializerPrefixURL: "bin/",
        arguments: ["input.ivf", "output.raw"],
    };
    NoiseModule(Module);
    Module.st = Module._rnnoise_create();
    Module.ptr = Module._malloc(480 * 4);
}

function removeNoise(buffer) {
    let ptr = Module.ptr;
    let st = Module.st;
    for (let i = 0; i < 480; i++) {
        Module.HEAPF32[(ptr >> 2) + i] = buffer[i] * 32768;
    }
    Module._rnnoise_process_frame(st, ptr, ptr);
    for (let i = 0; i < 480; i++) {
        buffer[i] = Module.HEAPF32[(ptr >> 2) + i] / 32768;
    }
}

const processorNode = ctx_main.createScriptProcessor(bufferSize, 1, 1);
initializeNoiseSuppressionModule();
processorNode.onaudioprocess = (e) => {
    var input = e.inputBuffer.getChannelData(0);
    var output = e.outputBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        inputBuffer.push(input[i]);
    }
    while (inputBuffer.length >= 480) {
        for (let i = 0; i < 480; i++) {
            frameBuffer[i] = inputBuffer.shift();
        }
        // Process Frame
        removeNoise(frameBuffer);
        for (let i = 0; i < 480; i++) {
            outputBuffer.push(frameBuffer[i]);
        }
    }
    // Not enough data, exit early, etherwise the AnalyserNode returns NaNs.
    if (outputBuffer.length < bufferSize) {
        return;
    }
    // Flush output buffer.
    for (let i = 0; i < bufferSize; i++) {
        output[i] = outputBuffer.shift();
    }
};


window.addEventListener('DOMContentLoaded', () => {

    const inputSelector = document.getElementById('audioInput')
    const outputSelector = document.getElementById('audioOutput')
    navigator.mediaDevices.enumerateDevices()
        .then(devices => {
            const inputList = []
            const outputList = []
            devices.forEach(device => {
                //console.log(device)
                if (device.kind === 'audioinput') {
                    inputList.push([device.label, device.deviceId])
                } if (device.kind === 'audiooutput') {
                    outputList.push([device.label, device.deviceId])
                }
            })
            inputList.forEach((device, index) => {
                const option = document.createElement('option')
                option.value = device[1]
                option.text = device[0]
                if (index === 0) {
                    option.selected = true
                }
                inputSelector.appendChild(option)
            })
            outputList.forEach((device, index) => {
                const option = document.createElement('option')
                option.value = device[1]
                option.text = device[0]
                if (index === 0) {
                    option.selected = true
                }
                outputSelector.appendChild(option)
            })
        })

    const setLocalAudioStream = async () => {
        //start with default input and output devices
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        sourceNode = ctx_main.createMediaStreamSource(localStream)
        gainNode = ctx_main.createGain()
        gainNode1 = ctx_main.createChannelMerger()
        destinationNode = ctx_main.createMediaStreamDestination()

        sourceNode.connect(gainNode)
        gainNode.connect(processorNode)
        processorNode.connect(gainNode1)
        gainNode1.connect(destinationNode)

        const finalStream = destinationNode.stream
        const localAudio = document.getElementById('localStream')
        localAudio.srcObject = finalStream
        const canvas = document.getElementById('visualizeCanvas')
        const visualizer = new AudioVisualizer(finalStream, canvas, 128);
        visualizer.start()
    }
    setLocalAudioStream()

    const noiseReduceSwitch = document.getElementById('noiseReduceSwitch')
    noiseReduceSwitch.checked = true
    let noiseReduceSwitch_state = true
    noiseReduceSwitch.addEventListener('change', async (e) => {
        noiseReduceSwitch_state = !noiseReduceSwitch_state
        if (noiseReduceSwitch_state) {
            gainNode.disconnect(destinationNode)
            gainNode.connect(processorNode)
            processorNode.connect(destinationNode)

            console.log('noise reduce:', noiseReduceSwitch_state)
        } else {
            gainNode.disconnect(processorNode)
            gainNode.connect(destinationNode)
            processorNode.disconnect(destinationNode)

            console.log('noise reduce:', noiseReduceSwitch_state)
        }
    })

    const callButton = document.getElementById('callButton')
    callButton.disabled = true

    const confirm_button = document.getElementById('confirm_button')
    confirm_button.addEventListener('click', () => {
        confirm_button.disabled = true

        //handle tailscale select event
        if (nw_select.value === 'tailscale') {
            ipcRenderer.send('choose_nw', 'tailscale')
        } else {
            const nwid = networkIds[optionsList.indexOf(nw_select.value)]
            const nwname = network_names[optionsList.indexOf(nw_select.value)]
            ipcRenderer.send('choose_nw', nwid)
        }
    })


    const appAudioInputConfirmButtom = document.getElementById('appAudioInputButton')
    appAudioInputConfirmButtom.addEventListener('click', () => {
        appAudioInputConfirmButtom.disabled = true
        ipcRenderer.send('ask_displaySources_window')
    })
    ipcRenderer.on('availableDisplaySources_window', (e, d) => {
        console.log(d)
        const div = document.getElementById('audioCapture')
        const audioSelector = document.createElement('select')
        const audioPreview = document.createElement('audio')
        audioPreview.controls = true
        audioPreview.autoplay = true
        audioPreview.volume = 0
        const confirmButton = document.createElement('button')
        confirmButton.innerText = 'confirm audio source'

        div.appendChild(audioSelector)
        div.appendChild(audioPreview)
        div.appendChild(confirmButton)

        for (let source of d) {
            const option = document.createElement('option')
            option.text = source.name
            option.value = source.id
            audioSelector.appendChild(option)
        }
        confirmButton.addEventListener('click', async () => {
            const value = audioSelector.value
            console.log(value)
            navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                    }
                },
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: value,
                    }
                }
            })
                .then((stream) => {
                    audioPreview.srcObject = stream

                    captureAudioSource = ctx_main.createMediaStreamSource(stream)
                    captureAudioSource.connect(gainNode1)

                    const visualizeCanvas = document.createElement('canvas')
                    div.appendChild(visualizeCanvas)
                    const visualizer = new AudioVisualizer(stream, visualizeCanvas, 128)
                    visualizer.start()
                })
                .catch(error => {
                    console.error(error)
                })
        })
    })

    const screenShareConfirmButton = document.getElementById('screenShareButton')
    screenShareConfirmButton.addEventListener('click', () => {
        screenShareConfirmButton.disabled = true
        ipcRenderer.send('ask_displaySources')
    })
    ipcRenderer.on('availableDisplaySources', (e, d) => {
        console.log(d)
        const div = document.getElementById('desktopCapture')
        const displaySelector = document.createElement('select')
        const displayPreview = document.createElement('video')
        displayPreview.autoplay = true
        displayPreview.style.width = '90%'
        displayPreview.style.height = '200px'
        const confirmButton = document.createElement('button')
        confirmButton.innerText = 'confirm screen share source'

        div.appendChild(displaySelector)
        div.appendChild(displayPreview)
        div.appendChild(confirmButton)
        for (let source of d) {
            const option = document.createElement('option')
            option.text = source.name
            option.value = source.id
            displaySelector.appendChild(option)
        }
        confirmButton.addEventListener('click', async () => {
            const value = displaySelector.value
            console.log(value)
            navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: value,
                    }
                }
            })
                .then((stream) => {
                    displayPreview.srcObject = stream
                })
                .catch(error => {
                    console.error(error)
                })

        })
    })


    ipcRenderer.on('nw_info', (e, d) => {
        if (JSON.stringify(ts_localIp) !== JSON.stringify(d.ts_localIp)) {
            const peersContent = ts_peersIp.length > 0 ? ts_peersIp.join('<br>') : 'no one else'
            const ts_state = document.getElementById('ts_state')
            ts_state.innerHTML = `Tailscale local IP: ${ts_localIp}<br>Tailnet peers: ${peersContent}<br>`
        }
        ts_localIp = d.ts_localIp
        ts_peersIp = d.ts_peersIp
        console.log(ts_localIp)
    })

    ipcRenderer.on('signaling_server_info', (e, d) => {
        //console.log(JSON.stringify(d, null, '\t'))
        const signaling_server_info = document.getElementById('signaling_server_info')
        if (d.found_signaling_server) {
            if (d.local_signaling_server) {
                signaling_server_info.innerHTML = `${d.current_signaling_server} (local)`
            } else {
                signaling_server_info.innerHTML = d.current_signaling_server
            }
            target_server = d.current_signaling_server

            if (!signaling_statue) {
                signaling = io(`http://${target_server}:8848`)
                signaling_statue = true
                signaling.on('connect', () => {
                    console.log(`local socket id: ${signaling.id}`)
                    setInterval(() => {
                        signaling.emit('ping', { localId: signaling.id })
                        ping_startTime = Date.now()
                    }, 1000);
                })
                signaling.on('pong', () => {
                    ping_endTime = Date.now()
                    const latency = ping_endTime - ping_startTime
                    const signaling_latency = document.getElementById('signaling_latency')
                    signaling_latency.innerHTML = latency + 'ms'
                })
                signaling.on('room_broadcast', (rm) => {
                    document.getElementById('members').innerHTML = rm.map(id => {
                        if (id === signaling.id) { return `${id} (local id) <br>` }
                        else { return `${id} <br>` }
                    })
                    if (rm.length >= 2) {
                        callButton.disabled = false
                    }
                    room_members = rm.filter(item => item !== signaling.id)// remove myself

                })

                signaling.emit('join', 'ready')

                signaling.on('offer', async (d) => {
                    console.log('offer recevied', d)
                    const r_pc = new RTCPeerConnection()
                    await r_pc.setRemoteDescription(d.data)
                    //const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

                    //get noise reduced (or not) stream
                    const finalStream = destinationNode.stream
                    //

                    finalStream.getTracks().forEach(track => r_pc.addTrack(track, finalStream))
                    const answer = await r_pc.createAnswer()
                    await r_pc.setLocalDescription(answer)
                    d['data'] = answer
                    signaling.emit('answer', d)

                    r_pc.ondatachannel = e => {
                        const r_dc = e.channel
                        if (r_dc.label === 'ping') {
                            r_dc.onmessage = e => {
                                //console.log(e.data)
                                r_dc.send('a ping receiption')
                            }
                        } if (r_dc.label === 'renegotiation') {
                            r_dc.onmessage = async (e) => {
                                console.log('receive data from renegotiation channel:', e.data)
                                const msg = JSON.parse(e.data)
                                if (msg.type === 'renegotiation_offer') {
                                    console.log(msg.data)
                                    await r_pc.setRemoteDescription(msg.data)
                                    const answer = await r_pc.createAnswer()
                                    await r_pc.setLocalDescription(answer)
                                    r_dc.send(JSON.stringify({ type: 'renegotiation_answer', data: answer }))

                                }
                            }
                        }
                    }

                    remotepcs[d.localId] = r_pc

                    /*
                    const tempdiv = document.createElement('div')
                    const visualizeCanvas = document.createElement('canvas')
                    const audio = document.createElement('audio')
                    audio.autoplay = true
                    audio.controls = true
                    r_pc.ontrack = e => {
                        audio.srcObject = e.streams[0]
                        const streamVisualizer = new StreamVisualizer(e.streams[0], visualizeCanvas, { WIDTH: 300, HEIGHT: 100 })
                        streamVisualizer.start()
                    }
                    tempdiv.appendChild(audio)
                    tempdiv.appendChild(visualizeCanvas)
                    const span = document.createElement('span')
                    span.innerHTML = 'audio from remotepc'
                    tempdiv.appendChild(span)
                    document.getElementById('audio_elements').appendChild(tempdiv)
                    */

                })
                signaling.on('answer', async (d) => {
                    console.log('answer received', d)
                    await localpcs[d.remoteId].setRemoteDescription(d.data);
                })
                signaling.on('icecandidate', async (d) => {
                    console.log('ice received')
                    if (!pendingIceCandidates[d.localId]) {
                        pendingIceCandidates[d.localId] = [];
                    }
                    pendingIceCandidates[d.localId].push(d.data);
                })
                setInterval(() => {
                    if (Object.keys(remotepcs).length > 0) {
                        for (let key of Object.keys(remotepcs)) {
                            const r_pc = remotepcs[key]
                            if (pendingIceCandidates[key]) {
                                pendingIceCandidates[key].forEach(candidate => {
                                    if (!r_pc.remoteDescription.sdp.includes(candidate.candidate)) {
                                        if (!candidate.candidate) {
                                            r_pc.addIceCandidate(null);
                                        } else {
                                            r_pc.addIceCandidate(candidate);
                                        }
                                    }
                                })
                                delete pendingIceCandidates[key]
                            }
                            remotepcs[key] = r_pc
                        }
                    }
                }, 100);
            }
        }
        if (!d.found_signaling_server && !d.local_signaling_server) {
            signaling_server_info.innerHTML = `(${d.current_signaling_server} should be signaling server, waitting for join)`
        }
        if (!d.found_signaling_server && d.current_signaling_server.length == 0) {
            signaling_server_info.innerHTML = '(found no one else in this network)'
        }
    })

    outputSelector.addEventListener('change', async () => {
        const outputDeviceId = outputSelector.value
        const outputAudios = Array.from(document.querySelectorAll('.localpcsOutputAudio'))
        outputAudios.push(document.getElementById('localStream'))
        outputAudios.forEach(audioElement => {
            audioElement.setSinkId(outputDeviceId)
        })

    })

    inputSelector.addEventListener('change', async () => {
        const inputDeviceId = inputSelector.value
        const newlocalStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: inputDeviceId },
            video: false
        })
        if (!localStream) { return }

        localStream.getAudioTracks().forEach(track => {
            track.stop();
            localStream.removeTrack(track);
        })
        newlocalStream.getAudioTracks().forEach(track => {
            localStream.addTrack(track);
        })

        sourceNode.disconnect(gainNode)
        sourceNode = ctx_main.createMediaStreamSource(localStream)
        sourceNode.connect(gainNode)

        if (Object.keys(remotepcs).length > 0) {
            for (let key of Object.keys(remotepcs)) {
                const r_pc = remotepcs[key]
                const sender = r_pc.getSenders().find(s => s.track.kind === 'audio');
                if (sender) {
                    sender.replaceTrack(localStream.getAudioTracks()[0]);
                }
                const offer = await r_pc.createOffer()
                await r_pc.setLocalDescription(offer)

                //const dc_r = dc_receive[key]
                //dc_r.send(JSON.stringify({ type: 'renegotiation_offer', data: offer }))
            }
        }

    })

    callButton.addEventListener('click', async () => {

        for (let i = 0; i < room_members.length; i++) {
            const pc = new RTCPeerConnection()
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream))

            dc_ping[room_members[i]] = pc.createDataChannel('ping')
            dc_ping[room_members[i]].onmessage = (e) => {
                if (e.data === 'a ping receiption') {
                    rtc_ping_endTime = Date.now()
                    rtc_latency = rtc_ping_endTime - rtc_ping_startTime
                }
            }
            dc_renegotiation[room_members[i]] = pc.createDataChannel('renegotiation')
            dc_renegotiation[room_members[i]].onmessage = async (e) => {
                const msg = JSON.parse(e.data)
                if (msg.type === 'renegotiation_offer') {
                    console.log(msg.data)
                    //pc.setLocalDescription(msg.data)
                }
            }
            pc.createOffer()
                .then(offer => {
                    pc.setLocalDescription(offer)
                    pc.onicecandidate = e => {
                        if (e.candidate) {
                            console.log('ice sent')
                            signaling.emit('icecandidate', { remoteId: room_members[i], data: e.candidate })
                        }
                    }
                    pc.oniceconnectionstatechange = e => {
                        //console.log(e)
                        //console.log(pc.iceConnectionState)
                    }
                    signaling.emit('offer', { id: room_members[i], data: offer })
                })
                .then(() => {

                    const tempdiv = document.createElement('div')
                    const visualizeCanvas = document.createElement('canvas')
                    const audio = document.createElement('audio')
                    audio.className = 'localpcsOutputAudio'
                    audio.autoplay = true
                    audio.controls = true
                    audio.volume = 0
                    pc.ontrack = e => {
                        audio.srcObject = e.streams[0]
                        const visualizer = new AudioVisualizer(e.streams[0], visualizeCanvas, 128);
                        visualizer.start()
                    }

                    /*
                    bitrateSeries = new TimelineDataSeries();
                    bitrateGraph = new TimelineGraphView('bitrateGraph', 'bitrateCanvas');
                    bitrateGraph.updateEndDate();
                    targetBitrateSeries = new TimelineDataSeries();
                    targetBitrateSeries.setColor('blue');
                    headerrateSeries = new TimelineDataSeries();
                    headerrateSeries.setColor('green');
                    packetSeries = new TimelineDataSeries();
                    packetGraph = new TimelineGraphView('packetGraph', 'packetCanvas');
                    packetGraph.updateEndDate();
                    */

                    tempdiv.appendChild(audio)
                    tempdiv.appendChild(visualizeCanvas)
                    const span = document.createElement('span')
                    span.innerHTML = 'audio from localpc'
                    tempdiv.appendChild(span)
                    document.getElementById('audio_elements').appendChild(tempdiv)

                    localpcs[room_members[i]] = pc
                })
        }
    })

    const netinfo = document.getElementById('netinfo')
    //netinfo.innerHTML = `Bandwidth usage - <br>upload:${uploadBandwidth} KB/s, <br>download${downloadBandwidth} KB/s`

    const pcs_div = document.getElementById('pcs')
    function generateConnectionInfoHTML() {
        const localPCsHTML = Object.values(connectionInfo.localPCs)
            .map(pc => `ID: ${pc.id}, Status: ${pc.state}, Ping Latency: ${pc.latency} ms`)
            .join('<br>');

        const remotePCsHTML = Object.values(connectionInfo.remotePCs)
            .map(pc => `ID: ${pc.id}, Status: ${pc.state}, Ping Latency: ${pc.latency} ms`)
            .join('<br>');

        return `
            Local PeerConnections:<br>
            ${localPCsHTML}<br>
            <br>
            Remote PeerConnections:<br>
            ${remotePCsHTML}
        `;
    }
    setInterval(() => {
        if (Object.keys(dc_ping).length > 0) {
            for (let key of Object.keys(dc_ping)) {
                const dc = dc_ping[key]
                if (dc.readyState === 'open') {
                    rtc_ping_startTime = Date.now()
                    dc.send('a ping msg')
                    //console.log('dc_ping sent')
                }
            }
        }
        if (Object.keys(localpcs).length > 0) {
            Object.keys(localpcs).forEach(key => {
                const pc = localpcs[key]
                connectionInfo.localPCs[key] = { id: key, state: pc.iceConnectionState, latency: rtc_latency }
            })
        }
        if (Object.keys(remotepcs).length > 0) {
            Object.keys(remotepcs).forEach(key => {
                const pc = remotepcs[key]
                connectionInfo.remotePCs[key] = { id: key, state: pc.iceConnectionState, latency: rtc_latency }
            })
        }

        pcs_div.innerHTML = generateConnectionInfoHTML()
    }, 1000);


    const bytesDiv = document.getElementById('bytes');
    let prevBytesSent = 0;
    let prevBytesReceived = 0;
    let r_prevBytesSent = 0;
    let r_prevBytesReceived = 0;
    function formatBytes(bytes) {
        if (bytes < 1024) {
            return bytes + ' B';
        } else if (bytes < 1024 * 1024) {
            return (bytes / 1024).toFixed(2) + ' KB';
        } else if (bytes < 1024 * 1024 * 1024) {
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        } else {
            return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
        }
    }
    setInterval(() => {
        /*
        Promise.all(localStatsPromises).then(statsReports => {
            let totalBytesSent = 0;
            let totalBytesReceived = 0;

            statsReports.forEach(stats => {
                stats.forEach(report => {
                    if (report.type === 'outbound-rtp') {
                        totalBytesSent += report.bytesSent;
                    } else if (report.type === 'inbound-rtp') {
                        totalBytesReceived += report.bytesReceived;
                    }
                });
            });

            const upSpeed = (totalBytesSent - prevBytesSent) / 0.5;
            const downSpeed = (totalBytesReceived - prevBytesReceived) / 0.5;
            prevBytesSent = totalBytesSent;
            prevBytesReceived = totalBytesReceived;

            document.getElementById('localBytesDiv').innerHTML = `localpcs total -- Upload: ${formatBytes(upSpeed)}/s, Download: ${formatBytes(downSpeed)}/s`;
        });

        Promise.all(remoteStatsPromises).then(statsReports => {
            let r_totalBytesSent = 0;
            let r_totalBytesReceived = 0;

            statsReports.forEach(stats => {
                stats.forEach(report => {
                    if (report.type === 'outbound-rtp') {
                        r_totalBytesSent += report.bytesSent;
                    } else if (report.type === 'inbound-rtp') {
                        r_totalBytesReceived += report.bytesReceived;
                    }
                });
            });

            const r_upSpeed = (r_totalBytesSent - r_prevBytesSent) / 0.5;
            const r_downSpeed = (r_totalBytesReceived - r_prevBytesReceived) / 0.5;
            r_prevBytesSent = r_totalBytesSent;
            r_prevBytesReceived = r_totalBytesReceived;

            document.getElementById('remoteBytesDiv').innerHTML = `remotepcs total -- Upload: ${formatBytes(r_upSpeed)}/s, Download: ${formatBytes(r_downSpeed)}/s`;
        });
        
        pcs_div.innerHTML = `
            local peerconnections: <br>
            ${localpcsList.map(list => list.toString()).join('<br>')}
            <br>
            remote peerconnections: <br>
            ${remotepcsList.map(list => list.toString()).join('<br>')}
        `;*/
        //pc.remoteDescription.sdp
        /*
        const sender = Object.values(localpcs)[0].getSenders()[0]
        if (!sender) {
            return
        }
        sender.getStats().then(stats => {
            let bytesSent = 0;
            let bytesReceived = 0;

            stats.forEach(report => {
                if (report.type === 'outbound-rtp') {
                    bytesSent += report.bytesSent;
                } else if (report.type === 'inbound-rtp') {
                    bytesReceived += report.bytesReceived;
                }
            });

            // 计算每秒的上下行字节数
            const upSpeed = (bytesSent - prevBytesSent) / 0.5; // 除以0.5是因为setInterval的间隔为500毫秒
            const downSpeed = (bytesReceived - prevBytesReceived) / 0.5;

            // 更新显示
            bytesDiv.innerHTML = `Upload: ${formatBytes(upSpeed)}/s<br>Download: ${formatBytes(downSpeed)}/s`;

            // 更新上一次的字节数
            prevBytesSent = bytesSent;
            prevBytesReceived = bytesReceived;
        });
        */
    }, 500)


})
/*
        sender.getStats()
            .then(res => {
                res.forEach(report => {
                    let bytes;
                    let headerBytes;
                    let packets;
                    if (report.type === 'outbound-rtp') {
                        if (report.isRemote) {
                            return;
                        }
                        const now = report.timestamp;
                        bytes = report.bytesSent;
                        headerBytes = report.headerBytesSent;

                        packets = report.packetsSent;
                        if (lastResult && lastResult.has(report.id)) {
                            const deltaT = (now - lastResult.get(report.id).timestamp) / 1000;
                            // calculate bitrate
                            const bitrate = 8 * (bytes - lastResult.get(report.id).bytesSent) /
                                deltaT;
                            const headerrate = 8 * (headerBytes - lastResult.get(report.id).headerBytesSent) /
                                deltaT;

                            // append to chart
                            bitrateSeries.addPoint(now, bitrate);
                            headerrateSeries.addPoint(now, headerrate);
                            targetBitrateSeries.addPoint(now, report.targetBitrate);
                            bitrateGraph.setDataSeries([bitrateSeries, headerrateSeries, targetBitrateSeries]);
                            bitrateGraph.updateEndDate();

                            // calculate number of packets and append to chart
                            packetSeries.addPoint(now, (packets -
                                lastResult.get(report.id).packetsSent) / deltaT);
                            packetGraph.setDataSeries([packetSeries]);
                            packetGraph.updateEndDate();
                        }
                    }
                })
                lastResult = res
            })*/

