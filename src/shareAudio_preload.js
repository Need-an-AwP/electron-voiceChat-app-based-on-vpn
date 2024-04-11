const { contextBridge, ipcRenderer } = require('electron')
const toBlobURL = require('stream-to-blob-url')

const getStreams = () => {
    const videoList = document.querySelectorAll('video')
    const audioList = document.querySelectorAll('audio')

    const streamList = []
    for (let element of videoList) {
        const captureStream = element.captureStream()
        const audioStream = captureStream.getAudioTracks()
        const videoStream = captureStream.getVideoTracks()
        videoStream.forEach(vt => {captureStream.removeTrack(vt)})
        streamList.push(captureStream)
    }
    for (let element of audioList) {
        const captureStream = element.captureStream()
        streamList.push(captureStream)
    }
    return streamList
}

window.addEventListener('DOMContentLoaded', async () => {
    ipcRenderer.send('request_port')



    let port
    ipcRenderer.on('port', e => {
        [port] = e.ports
        port.onmessage = (event) => {
            console.log('received result:', event.data)
        }

    })

    let haveActiveStream = false
    let streamList = []
    let mediaRecorders = {}
    setInterval(() => {
        if (!haveActiveStream) {
            streamList = getStreams()
            for (let stream of streamList) {
                if (stream.active) { haveActiveStream = true }
            }
        }

        if (haveActiveStream) {
            for (let stream of streamList) {
                if (!Object.keys(mediaRecorders).includes(stream.id)) {
                    const mediaRecorder = new MediaRecorder(stream)
                    mediaRecorder.ondataavailable = (event) => {
                        //console.log(event.data)
                        if (event.data.size > 0) { }
                        port.postMessage(event.data)
                    }
                    mediaRecorders[stream.id] = mediaRecorder
                }
            }
        }

    }, 200);

    setInterval(() => {
        for (let key of Object.keys(mediaRecorders)) {
            const recorder = mediaRecorders[key]
            if (recorder.state === 'inactive') { recorder.start() }
            recorder.requestData()
        }
    }, 60);





})