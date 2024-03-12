import * as React from "react";
import { useState, useEffect, useRef } from 'react';
import {
    FluentProvider,
    Button,
    Dropdown,
    makeStyles,
    Option,
    Text,
    Select,
    Body1Strong,
    Label,
    Slider
} from "@fluentui/react-components";
import StreamVisualizer from './components/streamvisualizer'
const io = require('socket.io-client')
const { ipcRenderer } = window.require('electron');


let signaling
let localpcs = {}
let remoteAudio = {}
let remoteVideo = {}
let ping_startTime
let ping_endTime


function App() {
    const [networkIds, setNetworkIds] = useState([])
    const [optionsList, setOptionsList] = useState([])
    const [selectedOption, setSelectedOption] = useState(null)
    const [signaling_server_info, setsignaling_server_info] = useState('')
    const [target_server, settarget_server] = useState('')
    const [room_members, setroom_members] = useState([])
    const [displaySources, setdisplaySources] = useState([])
    const [selectedDisplaySource, setSelectedDisplaySource] = useState(null)
    const chooseNetworkButton_statue = useRef(true)
    const join_statue = useRef(false)
    const callButton_statue = useRef(false)
    const hangupButton_statue = useRef(false)
    const screenShare_statue = useRef(false)

    // set ipcrenderer listener
    useEffect(() => {
        ipcRenderer.on('nw_info', (e, d) => {
            setNetworkIds(d.networkIds)
            const newOptionsList = d.networkIds.map((v, i) => {
                return v + '--' + d.network_names[i] + '--local:' + d.ipHere[i]
            })
            setOptionsList(newOptionsList)
        })

        ipcRenderer.on('signaling_server_info', (e, d) => {
            if (d.found_signaling_server) {
                if (d.local_signaling_server) {
                    setsignaling_server_info(d.current_signaling_server + '(local)')
                } else {
                    setsignaling_server_info(d.current_signaling_server)
                }
                settarget_server(d.current_signaling_server)
                chooseNetworkButton_statue.current = false
                join_statue.current = true

            }
            if (!d.found_signaling_server && !d.local_signaling_server) {
                setsignaling_server_info(`(${d.current_signaling_server} should be signaling server, waitting for join)`)
            }
            if (!d.found_signaling_server && d.current_signaling_server.length === 0) {
                setsignaling_server_info('(found no one else in this network)')
            }
        })

        ipcRenderer.on('availableDisplaySources', async (e, d) => {
            console.log(d)
            setdisplaySources(d)
        })

        return () => {
            ipcRenderer.removeAllListeners('signaling_server_info');
            ipcRenderer.removeAllListeners('nw_info');
        }
    }, [])

    const sendChoose_nw = () => {
        if (selectedOption) {
            const nwid = networkIds[optionsList.indexOf(selectedOption.optionValue)]
            ipcRenderer.send('choose_nw', nwid)
        }
    }


    const [audioInputDevices, setAudioInputDevices] = useState([])
    const [audioOutputDevices, setAudioOutputDevices] = useState([])
    const localAudioRef = useRef(null)
    const [localStream, setLocalStream] = useState(null)
    const gainNodeRef = useRef(null)
    const [sliderValue, setSliderValue] = useState(100)
    const [selectedAudioInputDeviceId, setSelectedAudioInputDeviceId] = useState(null)
    const [selectedAudioOutputDeviceId, setSelectedAudioOutputDeviceId] = useState(null)
    const localVisualizeRef = useRef(null)

    // get media devices list
    useEffect(() => {
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
                setAudioInputDevices(inputList)
                setAudioOutputDevices(outputList)
                if (inputList.length > 0) {
                    setSelectedAudioInputDeviceId(inputList[0][1]);
                }
                if (outputList.length > 0) {
                    setSelectedAudioOutputDeviceId(outputList[0][1])
                }
            })
            .catch(error => console.log(error))
    }, [])

    const getStream = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: selectedAudioInputDeviceId,
                    outputDeviceId: selectedAudioOutputDeviceId,
                },
                video: false,
            })
            const ctx = new AudioContext()
            const gainNode = ctx.createGain()
            gainNode.gain.value = 1 // 初始值为 100%
            const source = ctx.createMediaStreamSource(stream);
            source.connect(gainNode)
            //gain.connect(ctx.destination);
            gainNodeRef.current = gainNode

            if (localAudioRef.current) {
                //localAudioRef.current.srcObject = stream
                const media_destination = ctx.createMediaStreamDestination()
                gainNode.connect(media_destination)
                localAudioRef.current.srcObject = media_destination.stream
            }
            setLocalStream(stream)

            const loaclVisualizeCanvas = document.getElementById('localVisualize')
            localVisualizeRef.current = new StreamVisualizer(stream, loaclVisualizeCanvas, { WIDTH: 100, })

        } catch (error) {
            console.log(error)
        }
    }

    // get audio stream and load it
    useEffect(() => {
        if (selectedAudioInputDeviceId && selectedAudioOutputDeviceId) {
            getStream();
        }
        /*
        navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: selectedAudioInputDeviceId,
                outputDeviceId: selectedAudioOutputDeviceId,
            },
            video: false
        })
            .then((stream) => {
                const gainNode = ctx.createGain()
                gainNode.gain.value = 1 // 初始值为 100%

                const source = ctx.createMediaStreamSource(stream);
                source.connect(gainNode)
                //gain.connect(ctx.destination);
                gainNodeRef.current = gainNode

                if (localAudioRef.current) {
                    //localAudioRef.current.srcObject = stream
                    const media_destination = ctx.createMediaStreamDestination()
                    gainNode.connect(media_destination)
                    localAudioRef.current.srcObject = media_destination.stream
                }
                setLocalStream(stream)
            })
            .catch(error => console.log(error))
        */
        return () => {
            if (localStream) {
                const tracks = localStream.getTracks();
                tracks.forEach((track) => track.stop());
            }
        }
    }, [selectedAudioInputDeviceId, selectedAudioOutputDeviceId])

    const handleInputDeviceChanged = (e) => {
        setSelectedAudioInputDeviceId(e.target.value)
        handleLocalVoiceTestRef.current = !handleLocalVoiceTestRef.current
    }

    const handleOutputDeviceChanged = (e) => {
        setSelectedAudioOutputDeviceId(e.target.value)
        handleLocalVoiceTestRef.current = !handleLocalVoiceTestRef.current
    }

    const handleVolumeChange = (e) => {
        setSliderValue(e.target.value)
        const value = parseFloat(e.target.value / 100)
        //console.log(value)
        if (gainNodeRef.current) {
            gainNodeRef.current.gain.value = value
        }
    }

    const pingRef = useRef('')
    const join_button = () => {
        if (target_server.length === 0) {
            console.log('error at connecting to target signaling server')
            return
        }
        callButton_statue.current = true
        console.log('target signaling server', target_server)
        signaling = io(`http://${target_server}:8848`)

        let remotepcs = {};

        signaling.on('connect', () => {
            console.log(`local socket id: ${signaling.id}`)
            setInterval(() => {
                signaling.emit('ping', { localId: signaling.id })
                ping_startTime = Date.now()
            }, 1000);
        })

        signaling.on('room_broadcast', (rm) => {
            const member_html = rm.map((socketid) => `<div><span>${socketid}</span><br/></div>`).join('')
            document.getElementById('members').innerHTML = member_html
            // remove myself
            setroom_members(rm.filter(item => item !== signaling.id))
        })

        signaling.on('offer', async (d) => {
            remotepcs[d.localId] = new RTCPeerConnection()
            localStream.getTracks().forEach(track => remotepcs[d.localId].addTrack(track, localStream))
            await remotepcs[d.localId].setRemoteDescription(d.data)
            const answer = await remotepcs[d.localId].createAnswer();
            await remotepcs[d.localId].setLocalDescription(answer);
            d['data'] = answer
            signaling.emit('answer', d)
        })

        signaling.on('answer', async (d) => {
            await localpcs[d.remoteId].setRemoteDescription(d.data);
        })

        signaling.on('icecandidate', async (d) => {
            if (!d.data.candidate) {
                await remotepcs[d.localId].addIceCandidate(null);
            } else {
                //console.log(d.data)
                await remotepcs[d.localId].addIceCandidate(d.data)
            }
        })

        signaling.on('pong', () => {
            ping_endTime = Date.now()
            const latency = ping_endTime - ping_startTime
            pingRef.current = latency
        })

        signaling.emit('join', 'ready')

    }

    const callButton = async () => {
        callButton_statue.current = false
        hangupButton_statue.current = true
        screenShare_statue.current = true

        const audioTracks = localStream.getAudioTracks()
        if (audioTracks.length > 0) {
            console.log(`Using audio device: ${audioTracks[0].label}`);
        }

        for (let i = 0; i < room_members.length; i++) {
            localpcs[room_members[i]] = new RTCPeerConnection()
            localStream.getTracks().forEach(track => localpcs[room_members[i]].addTrack(track, localStream));
            const offer = await localpcs[room_members[i]].createOffer()
            await localpcs[room_members[i]].setLocalDescription(offer)
            signaling.emit('offer', { id: room_members[i], data: offer })

            localpcs[room_members[i]].onicecandidate = e => {
                if (e.candidate) {
                    signaling.emit('icecandidate', { remoteId: room_members[i], data: e.candidate })
                }
            }
            localpcs[room_members[i]].oniceconnectionstatechange = e => {
                //console.log(e)
            }
            const tempdiv = document.createElement('div')
            const visualizeCanvas = document.createElement('canvas')
            visualizeCanvas.style.backgroundColor = 'gray'

            remoteAudio[room_members[i]] = document.createElement('audio')
            remoteAudio[room_members[i]].controls = true
            remoteAudio[room_members[i]].autoplay = true
            localpcs[room_members[i]].ontrack = e => {
                remoteAudio[room_members[i]].srcObject = e.streams[0]
                const streamVisualizer = new StreamVisualizer(e.streams[0], visualizeCanvas, { WIDTH: 300, HEIGHT: 100 })
                streamVisualizer.start()
            }
            tempdiv.appendChild(visualizeCanvas)
            tempdiv.appendChild(remoteAudio[room_members[i]])
            document.getElementById('audio_elements').appendChild(tempdiv)
        }
    }

    const hangupButton = async () => {
        hangupButton_statue.current = false
        if (Object.keys(localpcs).length !== 0) {
            for (let id in localpcs) {
                localpcs[id].close()
            }
            localpcs = {}
        }
        localStream.getTracks().forEach(track => track.stop())
        setLocalStream(null)
        callButton_statue.current = true
        hangupButton_statue.current = false
    }

    const handleLocalVoiceTestRef = useRef(false)
    const handleLocalVoiceTest = () => {
        const audioele = document.getElementById('localAudio')
        if (!handleLocalVoiceTestRef.current) {
            audioele.play()
            handleLocalVoiceTestRef.current = true
            //localVisualizeRef.current.start()
        } else {
            audioele.pause()
            handleLocalVoiceTestRef.current = false
            //localVisualizeRef.current.stop()
        }
    }

    const screenShareRef = useRef(false)
    const screenshareButton = () => {
        ipcRenderer.send('ask_displaySources', {})
        screenShareRef.current = true
    }

    const [targetDisplaySourceId, setTargetDisplaySourceId] = useState('')
    const handleDisplaySourceConfirm = async () => {
        const source = displaySources.filter(item => item.name === selectedDisplaySource.optionValue)[0]
        console.log(source)
        setTargetDisplaySourceId(source)
    }

    useEffect(() => {
        if (targetDisplaySourceId.length !== 0) {
            navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: targetDisplaySourceId.id,
                        minWidth: 1280,
                        maxWidth: 1920,
                        minHeight: 720,
                        maxHeight: 1080
                    }
                }
            })
                .then(async (stream) => {
                    const displayPreview = document.getElementById('displayPreview')
                    displayPreview.srcObject = stream
                    /*
                    const localpcs_values = Object.values(localpcs)
                    const offers = await Promise.all(localpcs_values.map(pc => {
                        pc.addTrack(stream.getTracks()[0], localStream)
                        return pc.createOffer()
                    }))
                    return Promise.all(localpcs_values.map(pc => {
                        return pc.setLocalDescription(offers)
                    }))*/
                
                })
                .catch(error => {
                    console.error(error)
                })
        }
    }, [targetDisplaySourceId])


    return (
        <div className="App">
            <div style={{
                height: "100vh",
                width: "100vw",
                display: "flex",
                flexDirection: "row",
            }}>
                <div style={{
                    width: "60vw",
                    display: "flex",
                    flexDirection: "column",
                    borderRightStyle: "solid",
                    borderRightColor: "gray",
                    gap: "15px",
                    margin: "15px",
                }}>
                    <div>
                        <Dropdown
                            placeholder="Select a network"
                            defaultOpen
                            onOptionSelect={(e, d) => { setSelectedOption(d) }}
                            style={{ width: '90%' }}
                        >
                            {optionsList.map((option) => (
                                <Option key={option}>{option}</Option>
                            )
                            )}
                        </Dropdown>

                    </div>
                    <div>
                        <Button onClick={sendChoose_nw} disabled={!chooseNetworkButton_statue.current} shape="circular">Confirm to join this network</Button>
                    </div>
                    <div>
                        <Button onClick={join_button} disabled={!join_statue.current}>Join voice chat</Button>
                    </div>
                    <div>
                        <label>Input device</label>
                        <Select
                            style={{ width: '90%' }}
                            onChange={handleInputDeviceChanged}
                        >
                            {audioInputDevices.map((option) => (
                                <option value={option[1]} key={option[1]}>{option[0]}</option>
                            ))}
                        </Select>
                        <label>Output device</label>
                        <Select
                            style={{ width: '90%' }}
                            onChange={handleOutputDeviceChanged}
                        >
                            {audioOutputDevices.map((option) => (
                                <option value={option[1]} key={option[1]}>{option[0]}</option>
                            ))}
                        </Select>
                    </div>
                    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }}>
                        <label>local audio</label>
                        <Button size="small" onClick={handleLocalVoiceTest}>
                            {handleLocalVoiceTestRef.current ? 'stop' : 'test'}
                        </Button>
                        <Slider

                            min={0}
                            max={300}
                            defaultValue={100}
                            onChange={handleVolumeChange}
                        ></Slider>
                        <Text>{sliderValue}%</Text>
                        <audio id="localAudio" ref={localAudioRef} controls={false}></audio>
                    </div>
                    <div>
                        <Button onClick={callButton} shape="circular" disabled={!callButton_statue.current}>CALL</Button>
                        <Button onClick={hangupButton} shape="circular" disabled={!hangupButton_statue.current}>HANGUP</Button>
                    </div>
                    <div style={{ gap: "15px" }}>
                        <Button onClick={screenshareButton} shape="circular" disabled={!screenShare_statue.current}>SCREENSHARE</Button>
                        {screenShareRef.current ?
                            <div>
                                <Dropdown
                                    placeholder="Select a source"
                                    defaultOpen
                                    onOptionSelect={(e, d) => { setSelectedDisplaySource(d) }}
                                    style={{ width: '90%' }}
                                >
                                    {displaySources.map((option) => (
                                        <Option value={option.name} key={option.name}>{option.name}</Option>
                                    ))}
                                </Dropdown>

                                <Button onClick={handleDisplaySourceConfirm} shape="circular">Confirm</Button>
                                <video id="displayPreview" autoPlay style={{ width: "90%", height: "200px" }}></video>
                            </div>
                            :
                            null
                        }
                    </div>


                    <canvas id="localVisualize" style={{ width: "90%", height: "50px" }}></canvas>
                </div>
                <div style={{
                    width: "40vw",
                    display: "flex",
                    flexDirection: "column",
                    margin: "15px",
                    gap: "15px"
                }}>
                    <Text weight='bold' size={600}>signaling_server_info:</Text>
                    <Text weight='bold' size={500}>{signaling_server_info}</Text>
                    <Text>signaling server latency: {pingRef.current} ms</Text>
                    members: <span id="members"></span>

                    <div id="audio_elements"></div>
                </div>

            </div>



        </div>
    );
}

export default App;
