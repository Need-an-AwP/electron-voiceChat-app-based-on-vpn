class AudioVisualizer {
    constructor(audioStream, canvas, fftSize = 256) {
        this.audioContext = new AudioContext();
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = fftSize;
        this.source = this.audioContext.createMediaStreamSource(audioStream);
        this.source.connect(this.analyser);
        this.canvas = canvas;
        this.canvasContext = this.canvas.getContext('2d');
        this.bufferLength = this.analyser.frequencyBinCount;
        this.dataArray = new Uint8Array(this.bufferLength);
    }

    start() {
        this.draw();
    }

    draw() {
        requestAnimationFrame(this.draw.bind(this));

        this.analyser.getByteFrequencyData(this.dataArray);

        this.canvasContext.clearRect(0, 0, this.canvas.width, this.canvas.height);

        const barWidth = this.canvas.width / this.bufferLength;
        let x = 0;
        for (let i = 0; i < this.bufferLength; i++) {
            const barHeight = this.dataArray[i];
            this.canvasContext.fillStyle = 'rgb(' + (barHeight + 100) + ',180,200)';
            this.canvasContext.fillRect(x, this.canvas.height - barHeight / 2, barWidth, barHeight / 2);
            x += barWidth;
        }
    }


}

module.exports = AudioVisualizer;

