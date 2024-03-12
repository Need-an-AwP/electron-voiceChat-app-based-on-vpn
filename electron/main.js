const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const { exec } = require('child_process')
const { Server } = require('socket.io')
const http = require('http')
const express = require('express')


let globalData = {
    networkIds: null,
    ipHere: null,
    network_names: null,
    current_signaling_server: '',
    local_signal_server_status: false,
    found_signaling_server: false,
}

//------------server
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
    socket.on('join', (msg) => {
        console.log(msg, socket.id)
        if (msg === 'ready') {
            socket.join('ready')
        }
    })

    setInterval(() => {
        const room = socketServer.sockets.adapter.rooms.get('ready');
        const members = room ? Array.from(room) : [];
        socketServer.to('ready').emit('room_broadcast', members)
    }, 100);

    socket.on('offer', (msg) => {
        console.log('offer', msg)
        const id = msg.id
        const offer = msg.data
        //rewrite remoteid and localid from 
        socketServer.to(id).emit('offer', { remoteId: id, localId: socket.id, data: offer })
    })

    socket.on('answer', (msg) => {
        console.log('answer', msg)
        const id = msg.localId
        const answer = msg.data
        socketServer.to(id).emit('answer', msg)
    })

    socket.on('icecandidate', (msg) => {
        const id = msg.remoteId
        msg['localId'] = socket.id
        socketServer.to(id).emit('icecandidate', msg)
    })

    socket.on('ping', (msg) => {
        const id = msg.localId
        socketServer.to(id).emit('pong')
    })
})

server.listen(8848, '0.0.0.0', () => {
    console.log('(server online)')
    isServerRunning = true
})

//------------electron app window
const executelistnwCommand = async () => {
    return new Promise((resolve, reject) => {
        exec('zerotier-cli listnetworks -j', (error, stdout, stderr) => {
            if (error) {
                reject(`执行命令时发生错误: ${error.message}`);
                return;
            }
            if (stderr) {
                reject(`命令产生了错误输出: ${stderr}`);
                return;
            }

            try {
                const result = JSON.parse(stdout);
                const networkIds = result.map(nw => nw.nwid);
                const ipHere = result.map(nw => (nw.assignedAddresses[0]).slice(0, -3));
                const network_names = result.map(nw => nw.name)
                //console.log(networkIds);
                //console.log(ipHere);
                resolve({ networkIds, ipHere, network_names });
            } catch (parseError) {
                reject(`解析JSON时发生错误: ${parseError.message}`);
            }
        });
    });
}

const fetchNetworkMembers = async (networkId, auth_token) => {
    return new Promise((resolve, reject) => {
        fetch(`https://api.zerotier.com/api/v1/network/${networkId}/member`, {
            method: 'GET',
            headers: {
                'Authorization': `token ${auth_token}`,
                'Content-Type': 'application/json',
            }
        })
            .then(response => {
                if (!response.ok) { throw new Error(`HTTP error: ${response.status}`) }
                return response.json()
            })
            .then(data => {
                const memberIps = []
                data.forEach(item => {
                    memberIps.push(item.config.ipAssignments[0])
                })
                resolve(memberIps)
            })
            .catch(error => reject(error))
    })
}

let win = null;
app.whenReady().then(async () => {
    const { networkIds, ipHere, network_names } = await executelistnwCommand()
    globalData.networkIds = networkIds;
    globalData.ipHere = ipHere;
    globalData.network_names = network_names;
    console.log(network_names)
    console.log(networkIds)
    console.log(ipHere)

    win = new BrowserWindow({
        width: 800,
        height: 900,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            nodeIntegration: true,
            webSecurity: true,
        }
    })
    //develope setting
    const startUrl = 'http://localhost:3000'
    win.loadURL(startUrl)

    //build setting
    //win.loadFile('index.html')
    //win.loadFile('./build/index.html')

    win.webContents.openDevTools({ mode: 'detach' })

    setInterval(() => {
        //win.webContents.send('test_channel', 'message from main thread')    
        win.webContents.send('nw_info', { network_names: network_names, networkIds: networkIds, ipHere: ipHere })
    }, 500);
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});


//------------ipcmain activation
ipcMain.on('test_channel', (e, d) => {
    console.log(d)
})


ipcMain.on('choose_nw', async (e, nwid) => {
    const localIP_innw = globalData.ipHere[globalData.networkIds.indexOf(nwid)]
    const nwmb_withLocal = await fetchNetworkMembers(nwid, 'EDfiGTHCCoFOhIVjGgcp4STn03PtC8ix')
    const nwmb = nwmb_withLocal.filter(ip => { return !globalData.ipHere.includes(ip) })
    let online_member = []
    const timeout_t = 3000


    const fetchData = async () => {
        let fetchPromises = []
        for (let ip of nwmb) {
            const controller = new AbortController()
            const timeout = setTimeout(() => {
                controller.abort()
                //console.log("请求超时")
            }, timeout_t)

            const fetchPromise = fetch(`http://${ip}:8848/signal-server`, { signal: controller.signal })
                .then(res => {
                    if (res.ok) { return res.json() }
                })
                .then(data => {
                    //console.log(ip, data)
                    if (data.message == 'this is a signaling sErVeR') {
                        online_member.push(ip)
                        if (data.signaling) {
                            globalData.current_signaling_server = ip
                            globalData.found_signaling_server = true
                        }
                    }
                })
                .catch(error => {
                    if (error.name === 'AbortError') {
                        //console.log(`${ip} not online`)
                    } else {
                        //console.log(`${ip} not responsed`)
                    }
                })
                .finally(() => clearTimeout(timeout));

            fetchPromises.push(fetchPromise)
        }
        //console.log('checking online signaling server......')
        online_member.length = 0
        online_member.push(localIP_innw)
        await Promise.all(fetchPromises)
        if (online_member.length == 1) {
            console.log('no one else online')
            win.webContents.send('signaling_server_info', {
                found_signaling_server: false,
                current_signaling_server: ''
            })
        }
        if (online_member.length >= 2) {
            online_member.sort((a, b) => {
                let aNums = a.split(".")
                let bNums = b.split(".")
                for (let i = 0; i < 4; i++) {
                    let diff = parseInt(aNums[i]) - parseInt(bNums[i])
                    if (diff != 0) {
                        return diff
                    }
                }
                return 0
            })
            const first_choice_signalingServer = online_member[0]
            //console.log(`signaling server should be ${first_choice_signalingServer}`)
            //排序后发现自己是服务器
            if (localIP_innw == first_choice_signalingServer) {
                console.log('set local as signaling server')
                globalData.current_signaling_server = localIP_innw
                globalData.local_signal_server_status = true
                globalData.found_signaling_server = true
                win.webContents.send('signaling_server_info', {
                    found_signaling_server: true,
                    current_signaling_server: localIP_innw,
                    local_signaling_server: true
                })
                //发现非本地的在线服务器
            } if (globalData.found_signaling_server && !globalData.local_signal_server_status) {
                console.log('found_signaling_server', globalData.current_signaling_server)
                win.webContents.send('signaling_server_info', {
                    found_signaling_server: true,
                    current_signaling_server: globalData.current_signaling_server,
                    local_signaling_server: false
                })
                //等待加入房间
            } if (!globalData.found_signaling_server && globalData.local_signal_server_status) {
                //console.log(`found ${first_choice_signalingServer} online, waitting for join`)
                win.webContents.send('signaling_server_info', {
                    found_signaling_server: false,
                    current_signaling_server: first_choice_signalingServer,
                    local_signaling_server: false
                })
            }
        }
        //console.log(globalData)
        setTimeout(fetchData, timeout_t)
    }

    fetchData()

})


ipcMain.on('ask_displaySources', async (e, d) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] })
        .then((sources) => {
            win.webContents.send('availableDisplaySources', sources)
        })
        .catch(error => console.log(error))
})

ipcMain.on('captureSource', async (e, d) => {
    console.log(d)
    const displayStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: source.id,
                minWidth: 1280,
                maxWidth: 1280,
                minHeight: 720,
                maxHeight: 720
            }
        }
    })
})