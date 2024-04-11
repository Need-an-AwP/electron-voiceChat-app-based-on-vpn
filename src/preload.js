const { contextBridge, ipcRenderer } = require('electron')
const StreamVisualizer = require('../js/streamvisualizer')
const { TimelineDataSeries, TimelineGraphView } = require('../js/graph')
const AudioVisualizer = require('../js/AudioLevelVisualizer')
const NoiseModule = require('../js/noise')
const io = require('socket.io-client')

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
let ts_localIp = ''
let ts_peersIp = []

const pendingIceCandidates = {}; //ice candidate buffer
let room_members = {}
let localpcs = {}
let remotepcs = {}
let dc_ping = {}
let dc_renegotiation = {}
let dc_receive = {}
let target_server = ''
let socket_io = {}
let signaling_connections = {}
let availableSignalingConnection = {}
let inRoom_state = false
let pcChecking

let connected_ts_peersIp = []
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
        }).catch(error => { console.log(error) })

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


    const confirm_button = document.getElementById('confirm_button')
    confirm_button.disabled = true
    const leave_button = document.getElementById('leave_button')
    leave_button.disabled = true

    ipcRenderer.on('nw_info', (e, d) => {
        const ts_state = document.getElementById('ts_state')
        if (ts_peersIp === 'tailscale not available') {
            const peersContent = 'tailscale not available'
            ts_state.innerHTML = `Tailscale local IP: ${d.ts_localIp}<br>Tailnet peers: ${peersContent}<br>`
        } else {
            const peersContent = ts_peersIp.length > 0 ? (ts_peersIp.length > 1 ? ts_peersIp.join(', ') : ts_peersIp[0]) : 'no one else online'
            ts_state.innerHTML = `Tailscale local IP: ${d.ts_localIp}<br>Tailnet peers: ${peersContent}<br>`
        }
        ts_localIp = d.ts_localIp
        ts_peersIp = d.ts_peersIp
    })

    //automatically connect all signaling server
    setInterval(() => {
        if (ts_peersIp.length !== 0 && typeof (ts_peersIp) !== 'string') {
            for (let ip of ts_peersIp) {
                if (!socket_io[ip]) {
                    const socketConnection = io(`http://${ip}:8848`)
                    socket_io[ip] = socketConnection
                    //console.log(`created a new socketio object for ${ip}`)

                    socketConnection.on('connect', () => {
                        console.log(`local socket id: ${socketConnection.id}`)
                        const signaling_div = document.getElementById('signaling_div')
                        const info = document.createElement('span')
                        info.id = ip
                        signaling_div.appendChild(info)
                        confirm_button.disabled = false
                        setInterval(() => {
                            socketConnection.emit('ping', { localId: socketConnection.id })
                            ping_startTime = Date.now()
                        }, 1000);
                        signaling_connections[ip] = { signaling: socketConnection, ip: ip }
                        availableSignalingConnection[ip] = socketConnection
                    })
                    socketConnection.on('disconnect', () => {
                        const info = document.getElementById(ip)
                        info.innerHTML = ''
                        delete signaling_connections[ip]
                        delete availableSignalingConnection[ip]
                        delete socket_io[ip]
                    })
                    socketConnection.on('pong', () => {
                        ping_endTime = Date.now()
                        const latency = ping_endTime - ping_startTime
                        const info = document.getElementById(ip)
                        info.innerHTML = `connected to ${ip}'s signaling server with ${latency} ms` + '<br>'
                    })
                    socketConnection.on('answer', async (d) => {
                        if (localpcs[ip]) {
                            await localpcs[ip].setRemoteDescription(d.data)
                            console.log('answer received & remote description setted')
                        }
                    })
                }
            }
        }
    }, 1000);
    setInterval(() => {
        if (Object.keys(socket_io).length !== 0) {
            for (let ip of Object.keys(socket_io)) {
                const io = socket_io[ip]
                if (!io.connected) {
                    io.removeAllListeners()
                    io.close()
                    delete socket_io[ip]
                }
            }
        }
    }, 1500);


    confirm_button.addEventListener('click', () => {
        //confirm_button.disabled = true
        //leave_button.disabled = false

        //join status
        const room_members_ul = document.getElementById('room_members')
        const li = document.createElement('li')
        li.textContent = ts_localIp + '(local)'
        room_members_ul.appendChild(li)
        room_members[ts_localIp] = { ip: ts_localIp, state: 'join' }
        //check localpcs
        pcChecking = setInterval(() => {
            confirm_button.disabled = true
            leave_button.disabled = false
            for (let ip of Object.keys(availableSignalingConnection)) {
                const signaling = availableSignalingConnection[ip]
                signaling.emit('join', { localIp: ts_localIp, state: 'joined' })
                if (!localpcs[ip] && Object.keys(room_members).includes(ip) || localpcs[ip].connectionState === 'failed') {
                    const pc = new RTCPeerConnection()
                    localStream.getTracks().forEach(track => pc.addTrack(track, localStream))
                    pc.createOffer()
                        .then(offer => {
                            pc.setLocalDescription(offer)
                            pc.onicecandidate = e => {
                                if (e.candidate) {
                                    console.log('ice sent')
                                    signaling.emit('icecandidate', { offerIp: ts_localIp, localId: signaling.id, data: e.candidate })
                                }
                            }
                            pc.oniceconnectionstatechange = e => { }
                            signaling.emit('offer', { offerIp: ts_localIp, scoketId: signaling.id, data: offer })
                        })
                        .then(() => {
                            const tempdiv = document.createElement('div')
                            tempdiv.id = `div_${ip}`
                            const visualizeCanvas = document.createElement('canvas')
                            const audio = document.createElement('audio')
                            audio.id = `audio_${ip}`
                            audio.className = 'localpcsOutputAudio'
                            audio.autoplay = true
                            audio.controls = true
                            audio.volume = 0
                            pc.ontrack = e => {
                                audio.srcObject = e.streams[0]
                                const visualizer = new AudioVisualizer(e.streams[0], visualizeCanvas, 128);
                                visualizer.start()
                            }

                            const span = document.createElement('span')
                            span.innerHTML = `audio from localpc ${ip}`
                            tempdiv.appendChild(span)
                            tempdiv.appendChild(audio)
                            tempdiv.appendChild(visualizeCanvas)
                            document.getElementById('audio_elements').appendChild(tempdiv)
                            localpcs[ip] = pc
                        })
                        .catch(error => { console.log(error) })
                }
            }
        }, 200);

        /*
        for (let item of Object.values(signaling_connections)) {
            const signaling = item.signaling
            const ip = item.ip
            const pc = new RTCPeerConnection()
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream))
            pc.createOffer()
                .then(offer => {
                    pc.setLocalDescription(offer)
                    pc.onicecandidate = e => {
                        if (e.candidate) {
                            console.log('ice sent')
                            signaling.emit('icecandidate', { offerIp: ts_localIp, localId: signaling.id, data: e.candidate })
                        }
                    }
                    pc.oniceconnectionstatechange = e => { }
                    signaling.emit('offer', { offerIp: ts_localIp, scoketId: signaling.id, data: offer })
                })
                .then(() => {
                    const tempdiv = document.createElement('div')
                    const visualizeCanvas = document.createElement('canvas')
                    const audio = document.createElement('audio')
                    audio.id = `audio_${ip}`
                    audio.className = 'localpcsOutputAudio'
                    audio.autoplay = true
                    audio.controls = true
                    audio.volume = 0
                    pc.ontrack = e => {
                        audio.srcObject = e.streams[0]
                        const visualizer = new AudioVisualizer(e.streams[0], visualizeCanvas, 128);
                        visualizer.start()
                    }

                    tempdiv.appendChild(audio)
                    tempdiv.appendChild(visualizeCanvas)
                    const span = document.createElement('span')
                    span.innerHTML = 'audio from localpc'
                    tempdiv.appendChild(span)
                    document.getElementById('audio_elements').appendChild(tempdiv)

                    //positively reconnect rtc connnection when detected disconnect
                    pc.onconnectionstatechange = e => {
                        console.log(`peerconnection to ${ip} state changed to: ${pc.connectionState}`);
                        
                        if (pc.connectionState === 'disconnected') {
                            const reconnectRTC = setInterval(() => {
                                pc.createOffer({ iceRestart: true })
                                    .then(offer => {
                                        signaling.emit('offer', { offerIp: ts_localIp, scoketId: signaling.id, data: offer })
                                    })
                                    .then(() => {
                                        const audio = document.getElementById(`audio_${ip}`)
                                        pc.ontrack = e => {
                                            audio.srcObject = e.streams[0]
                                            const visualizer = new AudioVisualizer(e.streams[0], visualizeCanvas, 128);
                                            visualizer.start()
                                        }
                                    })
                            }, 500);
                        }

                    }

                    localpcs[ip] = pc
                })
                .catch(error => { console.log(error) })
        }*/
    })

    leave_button.addEventListener('click', () => {
        if (pcChecking) {
            clearInterval(pcChecking)
        }
        delete room_members[ts_localIp]
        for (const pc of Object.values(localpcs)) {
            pc.close();
        }
        localpcs = {};
        for (const pc of Object.values(remotepcs)) {
            pc.close();
        }
        remotepcs = {};
        connectionInfo.localPCs = {};
        connectionInfo.remotePCs = {};
        confirm_button.disabled = false;
        leave_button.disabled = true;
        const pcs_div = document.getElementById('pcs');
        pcs_div.innerHTML = '';
        const audio_elements = document.getElementById('audio_elements')
        audio_elements.innerHTML = 'remote audios';
    })


    const room_members_ul = document.getElementById('room_members')
    ipcRenderer.on('join', (e, d) => {
        room_members[d.localIp] = { ip: d.localIp, t: Date.now(), state: d.state }
    })
    setInterval(() => {
        room_members_ul.innerHTML = ''
        for (let ip of Object.keys(room_members)) {
            const item = room_members[ip]
            if (item.t) {
                const time = item.t
                if (Date.now() - time > 1500) {
                    delete room_members[ip]
                    const tempdiv = document.getElementById(`div_${ip}`)
                    tempdiv.innerHTML = ''
                }
            }
            const li = document.createElement('li')
            li.textContent = ip === ts_localIp ? ip + '(local)' : ip
            room_members_ul.appendChild(li)

        }
    }, 200);

    ipcRenderer.on('offer', async (e, d) => {
        //console.log(d.data)
        const r_pc = new RTCPeerConnection()
        await r_pc.setRemoteDescription(d.data)
        const finalStream = destinationNode.stream
        finalStream.getTracks().forEach(track => r_pc.addTrack(track, finalStream))
        const answer = await r_pc.createAnswer()
        await r_pc.setLocalDescription(answer)
        d['data'] = answer
        ipcRenderer.send('ipc_answer', JSON.stringify(d))

        const offerIp = d.offerIp
        remotepcs[offerIp] = r_pc
    })

    ipcRenderer.on('icecandidate', (e, d) => {
        console.log('ice received')
        if (!pendingIceCandidates[d.offerIp]) {
            pendingIceCandidates[d.offerIp] = [];
        }
        pendingIceCandidates[d.offerIp].push(d.data);
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


    const pcs_div = document.getElementById('pcs')
    function generateConnectionInfoHTML() {
        const localPCsHTML = Object.values(connectionInfo.localPCs)
            .map(pc => `ID: ${pc.id}, Status: ${pc.state}`)
            .join('<br>');

        const remotePCsHTML = Object.values(connectionInfo.remotePCs)
            .map(pc => `ID: ${pc.id}, Status: ${pc.state}`)
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
        /*
        if (Object.keys(dc_ping).length > 0) {
            for (let key of Object.keys(dc_ping)) {
                const dc = dc_ping[key]
                if (dc.readyState === 'open') {
                    rtc_ping_startTime = Date.now()
                    dc.send('a ping msg')
                    //console.log('dc_ping sent')
                }
            }
        }*/
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
    /*
    const appAudioInputButton = document.getElementById('appAudioInputButton')
    appAudioInputButton.addEventListener('click', () => {
        ipcRenderer.send('ask_displaySources_window')
        const div = document.getElementById('audioCapture')
        div.innerHTML = ''
    })
    ipcRenderer.on('availableDisplaySources_window', (e, d) => {
        //console.log(d)
        const div = document.getElementById('audioCapture')
        const audioSelector = document.createElement('select')
        const audioPreview = document.createElement('audio')
        audioPreview.controls = true
        audioPreview.autoplay = true
        audioPreview.volume = 0
        const confirmButton = document.createElement('button')
        confirmButton.innerText = 'confirm audio source'
        const visualizeCanvas = document.createElement('canvas')

        div.appendChild(audioSelector)
        div.appendChild(audioPreview)
        div.appendChild(confirmButton)
        div.appendChild(visualizeCanvas)
        let visualizer

        for (let source of d) {
            const option = document.createElement('option')
            option.text = source.name
            option.value = source.id
            audioSelector.appendChild(option)
        }
        confirmButton.addEventListener('click', async () => {
            confirmButton.disabled = true
            const value = audioSelector.value
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

                    //captureAudioSource = ctx_main.createMediaStreamSource(stream)
                    //captureAudioSource.connect(gainNode1)


                    visualizer = new AudioVisualizer(stream, visualizeCanvas, 128)
                    visualizer.start()
                })
                .catch(error => {
                    console.error(error)
                })
        })
    })

    const screenShareButton = document.getElementById('screenShareButton')
    screenShareButton.addEventListener('click', () => {
        ipcRenderer.send('ask_displaySources')
        const div = document.getElementById('desktopCapture')
        div.innerHTML = ''
    })
    ipcRenderer.on('availableDisplaySources', (e, d) => {
        const div = document.getElementById('desktopCapture')
        const displaySelector = document.createElement('select')
        const displayPreview = document.createElement('video')
        displayPreview.controls = false
        displayPreview.autoplay = true
        displayPreview.style = "width: 90%; height: 200px;"

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
            confirmButton.disabled = true
            const value = displaySelector.value
            navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: value,
                    }
                }
            }).then((stream) => {
                displayPreview.srcObject = stream
            })
        })
    })*/

    const shareAudioButton = document.getElementById('share_audio')
    const shareAudioInput = document.getElementById('share_audio_input')
    const shareAudioDiv = document.getElementById('share_audio_div')
    shareAudioButton.addEventListener('click', () => {
        let link = shareAudioInput.value
        if (link === '') { link = 'https://www.youtube.com/watch?v=9hpIW8sl6JE&list=RDQWG8qryIENA&index=10' }
        ipcRenderer.send('shareAudio', link)
        //const webview = document.createElement('webview')

    })

    const fileReader = new FileReader();
    function handleShareBlob(blob) {
        if (!sourceBuffer) return;
        if (sourceBuffer && sourceBuffer.updating) {
            //sourceBuffer.abort();
        }
        fileReader.onload = () => {
            const arrayBuffer = fileReader.result;
            sourceBuffer.appendBuffer(arrayBuffer);
        };
        fileReader.readAsArrayBuffer(blob);
    }

    let port
    let shareMediaSource
    let sourceBuffer
    ipcRenderer.on('port', e => {
        [port] = e.ports
        port.onmessage = (event) => {
            const blob = event.data
            //console.log('received result:', blob)

            if (!shareMediaSource) {
                shareMediaSource = new MediaSource()
                shareMediaSource.addEventListener('sourceopen', () => {
                    sourceBuffer = shareMediaSource.addSourceBuffer(blob.type)
                })
                const shareAudio = document.createElement('audio')
                shareAudio.controls = true
                shareAudio.autoplay = true
                shareAudio.src = URL.createObjectURL(shareMediaSource)
                shareAudioDiv.appendChild(shareAudio)

                const shareAudioSource = ctx_main.createMediaElementSource(shareAudio)
                const gainNode_share = ctx_main.createGain()
                shareAudioSource.connect(gainNode_share)
                gainNode_share.gain.value = 0.5
                gainNode_share.connect(gainNode1)
            }
            handleShareBlob(blob)
        }
        console.log(port)
    })
    ////////
    /*
    let mediaRecorders = {}
    let streamList = []

    const videoList = document.querySelectorAll('video')
    const audioList = document.querySelectorAll('audio')
    for (let element of videoList) {
        const captureStream = element.captureStream()
        streamList.push(captureStream)
    }
    for (let element of audioList) {
        const captureStream = element.captureStream()
        streamList.push(captureStream)
    }

    for (let stream of streamList) {
        const mediaRecorder = new MediaRecorder(stream)
        mediaRecorder.ondataavailable = (event) => {
            console.log(event.data)
            console.log(event)
            if (event.data.size > 0) {
                //port.postMessage(event.data)
            }
        }
        
        mediaRecorders[stream.id] = mediaRecorder
    }
    setInterval(() => {
        for( let key of Object.keys(mediaRecorders)){
            const recorder = mediaRecorders[key]
            if (recorder.state === 'inactive') {
                recorder.start()
            }
            recorder.requestData()
        }
    }, 200);
    */
    ////////
})
