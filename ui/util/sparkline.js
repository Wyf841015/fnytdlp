// Sparkline — lightweight canvas-based micro chart for KPI cards
// Each instance maintains its own rolling buffer and renders a smooth line + filled area.

const SPARK_MAX_SAMPLES = 30;     // ~30 samples × 2s = 60s history window
const SPARK_DEFAULT_INTERVAL = 2000;

class Sparkline {
  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.maxSamples = options.maxSamples || SPARK_MAX_SAMPLES;
    this.interval = options.interval || SPARK_DEFAULT_INTERVAL;
    this.color = options.color || null; // null = use canvas data-kpi CSS var
    this.buffer = [];
    this._timer = null;
    this._setupHiDPI();
  }

  _setupHiDPI() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.scale(dpr, dpr);
    this._w = w;
    this._h = h;
  }

  _getColor() {
    if (this.color) return this.color;
    // Read CSS vars --kpi-accent-h/s/l from parent .kpi-card and compose hsl()
    const card = this.canvas.closest('.kpi-card');
    if (!card) return '#3eb95f';
    const style = getComputedStyle(card);
    const h = style.getPropertyValue('--kpi-accent-h').trim();
    const s = style.getPropertyValue('--kpi-accent-s').trim();
    const l = style.getPropertyValue('--kpi-accent-l').trim();
    if (h && s && l) return `hsl(${h}, ${s}, ${l})`;
    return '#3eb95f';
  }

  push(value) {
    if (typeof value !== 'number' || isNaN(value)) value = 0;
    this.buffer.push(value);
    if (this.buffer.length > this.maxSamples) this.buffer.shift();
    this.render();
  }

  start(initialValue = 0) {
    this.buffer = new Array(this.maxSamples).fill(initialValue);
    this.render();
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), this.interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _tick() {
    // Tick can be overridden; base class just re-renders the buffer
    this.render();
  }

  render() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;
    const color = this._getColor();
    ctx.clearRect(0, 0, w, h);

    if (this.buffer.length < 2) return;

    // Compute min/max for scaling
    const max = Math.max(...this.buffer, 1);
    const min = 0;
    const range = max - min || 1;

    // Map buffer index → x
    const stepX = w / (this.maxSamples - 1);
    const offsetX = (this.maxSamples - this.buffer.length) * stepX;

    // Draw gradient fill under the line
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, this._toRgba(color, 0.35));
    grad.addColorStop(1, this._toRgba(color, 0));

    ctx.beginPath();
    ctx.moveTo(offsetX, h);
    this.buffer.forEach((v, i) => {
      const x = offsetX + i * stepX;
      const y = h - ((v - min) / range) * (h - 2) - 1;
      if (i === 0) ctx.lineTo(x, y);
      else ctx.lineTo(x, y);
    });
    const lastX = offsetX + (this.buffer.length - 1) * stepX;
    ctx.lineTo(lastX, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw line on top
    ctx.beginPath();
    this.buffer.forEach((v, i) => {
      const x = offsetX + i * stepX;
      const y = h - ((v - min) / range) * (h - 2) - 1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Draw last value dot
    const lastY = h - ((this.buffer[this.buffer.length - 1] - min) / range) * (h - 2) - 1;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  _toRgba(color, alpha) {
    if (!color) return `rgba(62, 185, 95, ${alpha})`;
    if (color.startsWith('#')) {
      let h = color.replace('#', '');
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    if (color.startsWith('hsl(')) {
      return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
    }
    return `rgba(62, 185, 95, ${alpha})`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Sparkline, SPARK_MAX_SAMPLES, SPARK_DEFAULT_INTERVAL };
}
if (typeof window !== 'undefined') {
  window.Sparkline = Sparkline;
}
