/*const audioContext = new AudioContext();
async function createNoiseReductionStream(stream) {
    const source = audioContext.createMediaStreamSource(stream);
    const filter = audioContext.createBiquadFilter();

    // 设置高通滤波器的参数
    filter.type = 'highpass';
    filter.frequency.value = 200; // 调整滤波器的截止频率

    source.connect(filter);

    const destination = audioContext.createMediaStreamDestination();
    filter.connect(destination);

    return destination.stream;
}   

module.exports = { createNoiseReductionStream };
*/
//const NoiseModule = require("noise")

let Module;

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

let frameBuffer = [];
var inputBuffer = [];
var outputBuffer = [];
var bufferSize = 16384;

async function createNoiseReductionStream(stream) {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(16384, 1, 1);
    const destination = audioContext.createMediaStreamDestination();

    // 连接音频节点
    source.connect(processor);
    processor.connect(destination);

    // 初始化降噪模块
    initializeNoiseSuppressionModule();

    // 实时处理音频数据
    processor.onaudioprocess = (e) => {
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

    return destination.stream;
}


module.exports = { createNoiseReductionStream };