const { app, BrowserWindow, ipcMain, desktopCapturer, net, BrowserView, MessageChannelMain } = require('electron');
const path = require('path');
const { exec } = require('child_process')
const { Server } = require('socket.io')
const http = require('http')
const express = require('express')

const clientId = 'kccLVXEp3e11CNTRL'
const clientSecret = 'tskey-client-kccLVXEp3e11CNTRL-tYbYDRekUh1EsDrXfVYih1HK9GCFuFb4J'
let globalData = {
    current_signaling_server: '',
    local_signal_server_status: false,
    found_signaling_server: false,
    ts_localIp: null,
    ts_peersIp: null
}
let shareWindow = null;
let win = null;

//------------server
let room_members = new Set()
let isServerRunning = false
const serverapp = express()
serverapp.get('/signal-server', (req, res) => {
    res.json({
        message: 'this is a signaling sErVeR',
        signaling: globalData.local_signal_server_status
    })
})

const server = http.createServer(serverapp);
const socketServer = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
socketServer.on('connection', (socket) => {
    socket.on('offer', (msg) => {
        //console.log('offer', msg)
        const id = msg.id
        const offer = msg.data
        //socketServer.to(id).emit('offer', { remoteId: id, localId: socket.id, data: offer })
        win.webContents.send('offer', msg)
    })

    socket.on('answer', (msg) => {
        //console.log('answer', msg)
        //const id = msg.localId
        //const answer = msg.data
        win.webContents.send('answer', msg)
    })

    socket.on('icecandidate', (msg) => {
        //const id = msg.remoteId
        msg['localId'] = socket.id
        win.webContents.send('icecandidate', msg)
    })

    socket.on('ping', (msg) => {
        const id = msg.localId
        socketServer.to(id).emit('pong')
    })

    socket.on('join', (msg) => {
        //room_members.add(d.localIp)
        win.webContents.send('join', msg)

    })
})


function executeCommand(command) {
    return new Promise((resolve, reject) => {
        const child = exec(command, (err, stdout, stderr) => {
            if (stdout) {
                //console.log(stdout)
                resolve(stdout)
            } if (err) {
                //console.log(err)
                resolve(err)
            } if (stderr) {
                //console.log(stderr)
                resolve(stderr)
            }
        })
        const timer = setTimeout(() => {
            child.kill(); // 终止执行指令的函数
            console.log(`${command} execution timed out`)
            resolve('Command execution timed out'); // 返回超时错误
        }, 1000);

        child.on('exit', () => {
            clearTimeout(timer); // 清除定时器
        });
    })
}

const checkTsAvailable = async () => {
    const res = await executeCommand('tailscale --version')
    if (res.length > 3) {
        const result = await executeCommand('tailscale status --json')
        const tsStatus = JSON.parse(result)
        if (tsStatus.BackendState === 'NoState') {
            console.log('tailscale exist but no running')
            return ({ tailscaleAvailable: false })
        } else {
            return ({ tailscaleAvailable: true })
        }
    } else {
        return ({ tailscaleAvailable: false })
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const collectTsMembers = async () => {
    try {
        let result = ''
        let localIp = ''
        let peersIp = []
        result = await executeCommand('tailscale status --json')
        const tsStatus = JSON.parse(result)

        if (tsStatus.Health !== null) { console.log(tsStatus.Health) }

        if (tsStatus.BackendState === 'NeedsLogin') {
            console.log('trying tailscale login')
            result = await executeCommand(`tailscale up --auth-key=${clientSecret} --advertise-tags=tag:voicechat`)
            await delay(6000)
            collectTsMembers()
        } if (tsStatus.BackendState === 'Running') {
            if (tsStatus.Self.Tags) {
                if (tsStatus.Self.Tags.includes('tag:voicechat')) {
                    if (tsStatus.Health !== null) {
                        if (tsStatus.Health.includes('not in map poll')) {
                            result = await executeCommand(`tailscale logout`)
                            result = await executeCommand(`tailscale up --auth-key=${clientSecret} --advertise-tags=tag:voicechat`)
                            await delay(6000)
                            collectTsMembers()
                        } else {
                            localIp = tsStatus.TailscaleIPs[0]

                            if (tsStatus.Peer) {
                                for (let peer of Object.values(tsStatus.Peer)) {
                                    if (peer.Online) {
                                        peersIp.push(peer.TailscaleIPs[0])
                                    }
                                }
                                return ({ localIp, peersIp })
                            } else {
                                return ({ localIp, peersIp: [] })
                            }
                        }
                    }
                    if (tsStatus.Health === null) {
                        localIp = tsStatus.TailscaleIPs[0]

                        if (tsStatus.Peer) {
                            for (let peer of Object.values(tsStatus.Peer)) {
                                peersIp.push(peer.TailscaleIPs[0])
                            }
                            return ({ localIp, peersIp })
                        } else {
                            return ({ localIp, peersIp: [] })
                        }
                    }
                }
            }
            else {
                collectTsMembers()
            }
        } if (tsStatus.BackendState === 'Stopped') {
            result = await executeCommand(`tailscale up`)
            await delay(3000)
            collectTsMembers()
        }
    }
    catch (error) {
        console.log(error)
    }

}


app.whenReady().then(async () => {
    win = new BrowserWindow({
        width: 800,
        height: 900,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            nodeIntegration: true,
            webSecurity: true,
            //webviewTag: true
        }
    })

    win.loadFile('src/index.html')
    win.webContents.openDevTools({ mode: 'detach' })
    win.on('close', ()=> {
        BrowserWindow.getAllWindows().forEach(window => {
            window.close()
        })
    })

    setInterval(async () => {
        const check = await checkTsAvailable()
        if (check.tailscaleAvailable) {
            const { localIp: ts_localIp, peersIp: ts_peersIp } = await collectTsMembers()
            if (ts_localIp && ts_peersIp) {
                globalData.ts_localIp = ts_localIp
                globalData.ts_peersIp = ts_peersIp
                if (!isServerRunning) {
                    server.listen(8848, '0.0.0.0', () => {
                        console.log('(server online)')
                        isServerRunning = true
                    })
                }
            }
        } else {
            globalData.ts_localIp = 'tailscale not available'
            globalData.ts_peersIp = 'tailscale not available'
        }
        win.webContents.send('nw_info', {
            ts_localIp: globalData.ts_localIp,
            ts_peersIp: globalData.ts_peersIp
        })
    }, 6000);
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
})

ipcMain.on('ipc_answer', (e, d) => {
    //console.log(d)
    socketServer.emit('answer', JSON.parse(d))
})

ipcMain.on('ask_displaySources', () => {
    desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: true })
        .then((sources) => {
            win.webContents.send('availableDisplaySources', sources)
        })
        .catch(error => console.log(error))
})

ipcMain.on('ask_displaySources_window', () => {
    desktopCapturer.getSources({ types: ['window'], fetchWindowIcons: true })
        .then((sources) => {
            win.webContents.send('availableDisplaySources_window', sources)
        })
        .catch(error => console.log(error))
})

ipcMain.on('shareAudio', (e, d) => {
    shareWindow = new BrowserWindow({
        width: 1920 / 2,
        height: 1080 / 2,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'shareAudio_preload.js'),
            nodeIntegration: true,
            contextIsolation: false
        }
    })
    shareWindow.loadURL(d)
    shareWindow.webContents.openDevTools({ mode: 'detach' })

})

ipcMain.on('request_port', () => {
    const { port1, port2 } = new MessageChannelMain()
    if (win && shareWindow) {
        win.webContents.postMessage('port', null, [port1])
        shareWindow.webContents.postMessage('port', null, [port2])
    }
})

ipcMain.on('streamList', (e, d) => {
    console.log(d)
})

