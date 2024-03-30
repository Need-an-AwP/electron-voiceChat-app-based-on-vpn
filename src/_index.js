const { app, BrowserWindow, ipcMain, desktopCapturer, net } = require('electron');
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
    ts_localIp: null,
    ts_peersIp: null
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
    }, 500);

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
//------------tailscale availability check
const clientId = 'kccLVXEp3e11CNTRL'
const clientSecret = 'tskey-client-kccLVXEp3e11CNTRL-tYbYDRekUh1EsDrXfVYih1HK9GCFuFb4J'

//a way to execute command without any error interrupt
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


const collectTsMembers = async () => {
    try {
        let result = ''
        let localIp = ''
        let peersIp = []
        result = await executeCommand('tailscale status --json')
        const tsStatus = JSON.parse(result)
        if (tsStatus.BackendState === 'NeedsLogin') {
            console.log('trying tailscale login')
            result = await executeCommand(`tailscale up --auth-key=${clientSecret} --advertise-tags=tag:voicechat`)
            collectTsMembers()
        } if (tsStatus.BackendState === 'Running') {
            if (tsStatus.Self.Tags) {
                if (tsStatus.Self.Tags.includes('tag:voicechat') || tsStatus.Health === null) {
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
            } else {
                collectTsMembers()
            }
        }
    }
    catch (error) {
        console.log(error)
    }

}
const _collectTsMembers = async () => {
    let result = ''
    let localIp = ''
    let peersIp = []
    try {
        //clearLoggedAccount()
        result = await executeCommand('tailscale status --json')
        const tsStatus = JSON.parse(result)

        if (tsStatus.BackendState === 'NeedsLogin') {
            console.log('trying tailscale login')
            result = await executeCommand(`tailscale up --auth-key=${clientSecret} --advertise-tags=tag:voicechat`)
            collectTsMembers()
        } if (tsStatus.BackendState === 'Running') {
            if (tsStatus.Health !== null) {

            }
            if (tsStatus.Self.Tags) {
                if (tsStatus.Self.Tags.includes('tag:voicechat')) {
                    localIp = tsStatus.TailscaleIPs[0]
                    if (tsStatus.Peer) {
                        for (let peer of Object.values(tsStatus.Peer)) {
                            peersIp.push(peer.TailscaleIPs[0])
                        }
                        return ({ localIp, peersIp })
                    } else {
                        return ({ localIp: 'found no one else in tailnet', peersIp: 'found no one else in tailnet' })
                    }
                } else {
                    console.log('account have tags but incorrect')
                    result = await executeCommand('tailscale logout')
                    result = await executeCommand(`tailscale up --auth-key=${clientSecret} --advertise-tags=tag:voicechat`)
                    collectTsMembers()
                }
            } else {
                console.log('account have no tags, trying re-login')
                result = await executeCommand('tailscale logout')
                result = await executeCommand(`tailscale up --auth-key=${clientSecret} --advertise-tags=tag:voicechat`)
                collectTsMembers()
            }
        }

    } catch (error) {
        console.error('执行命令时发生错误:', error);
    }
}


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
    //react develope setting
    //const startUrl = 'http://localhost:3000'
    //win.loadURL(startUrl)

    //build setting
    win.loadFile('src/index.html')
    //win.loadFile('./build/index.html')
    win.webContents.openDevTools({ mode: 'detach' })

    setInterval(async () => {
        const check = await checkTsAvailable()
        if (check.tailscaleAvailable) {
            const { localIp: ts_localIp, peersIp: ts_peersIp } = await collectTsMembers()
            globalData.ts_localIp = ts_localIp
            globalData.ts_peersIp = ts_peersIp
            //console.log('tailscale available local:', ts_localIp)
            //console.log('tailscale available peers:', ts_peersIp)
        } else {
            globalData.ts_localIp = 'tailscale not available'
            globalData.ts_peersIp = 'tailscale not available'
        }
        win.webContents.send('nw_info', {
            ts_localIp: globalData.ts_localIp,
            ts_peersIp: globalData.ts_peersIp
        })
    }, 3000);

    setInterval(() => {
        const localIP_innw = globalData.ts_localIp
        const ts_members = globalData.ts_peersIp// not include myself
        let online_member = []
        const timeout_t = 1000

        const fetchData = async () => {
            let fetchPromises = []
            for (let ip of ts_members) {
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
            online_member.length = 0
            online_member.push(localIP_innw)
            await Promise.all(fetchPromises)
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
                    //console.log('found_signaling_server', globalData.current_signaling_server)
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
            setTimeout(fetchData, timeout_t)
        }
        fetchData()

    }, 1000);
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
    if (nwid !== 'tailscale') {
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
                    //console.log('found_signaling_server', globalData.current_signaling_server)
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
    } else {
        const localIP_innw = globalData.ts_localIp
        const ts_members = globalData.ts_peersIp// not include myself
        let online_member = []
        const timeout_t = 1000

        const fetchData = async () => {
            let fetchPromises = []
            for (let ip of ts_members) {
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
            online_member.length = 0
            online_member.push(localIP_innw)
            await Promise.all(fetchPromises)
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
                    //console.log('found_signaling_server', globalData.current_signaling_server)
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
            setTimeout(fetchData, timeout_t)
        }
        fetchData()

    }

})


ipcMain.on('ask_displaySources', async (e, d) => {
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

