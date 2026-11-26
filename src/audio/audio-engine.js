// 模块: audio-engine.js
// 高性能音频分析与节拍检测引擎：
//   - 正确解析 Wallpaper Engine 128-bin 立体声布局（[0..63] 左声道 + [64..127] 右声道）
//   - 音频新帧驱动频谱通量（Flux）+ 时间归一化指数滑动统计（高刷屏零漂移、零重复帧误触发）
//   - 慢追踪自动增益（AGC）+ 软拐点压缩 + 非对称快启慢落平滑（兼顾响度自适应与鼓点瞬态）
"use strict";

function softCompress(val, ref, bandBoost = 1.0) {
  if (val <= 0) return 0;
  const norm = (val * bandBoost) / ref;
  return norm / (1.0 + norm * 0.72);
}

/**
 * 节拍触发器 — 检测音频能量峰值触发视觉效果（Pulse 波纹 / Meteor 流星）
 * Auto Beat 模式基于时间归一化频谱正通量（flux）的指数均值/方差动态阈值
 * Advanced 模式基于指定频段阈值
 */
class BeatTrigger {
  constructor(action) {
    this.action = action;
    this.freqIndex = -1;
    this.threshold = 0.5;
    this.sensitivity = 0.2;
    this.cooldown = 20;
    this.bandStart = 0;
    this.bandEnd = 5;
    this.pulseStrength = 0.35;
    this.minRawEnergy = 0.03;
    this.minRawFlux = 0.008;
    this.currentCooldown = 0;
    this.beatHold = 0;
    // 时间归一化指数滑动统计（替代固定帧数循环缓冲，彻底消除帧率耦合与长期浮点漂移）
    this.emaMean = 0;
    this.emaVar = 0;
    this.smoothedFlux = 0;
    this.prevSmoothedFlux = 0;
    this.statsInitialized = false;
    this.enabled = true;
    this.mode = "Auto Beat";
    if (action === "Pulse") {
      // 立体声合并 64-bin 的低频底鼓区 (b0..b5)
      this.bandStart = 0;
      this.bandEnd = 5;
      this.sensitivity = 0.2;
      this.cooldown = 30;
      this.pulseStrength = 0.35;
      this.minRawEnergy = 0.035;
      this.minRawFlux = 0.009;
    } else if (action === "Meteor") {
      // 立体声合并 64-bin 的中高频/瞬态泛音区 (b20..b46: 军鼓/镲片/钢琴与合成器高音)
      this.bandStart = 20;
      this.bandEnd = 46;
      this.sensitivity = 0.2;
      this.cooldown = 60;
      this.pulseStrength = 0.55;
      this.minRawEnergy = 0.02;
      this.minRawFlux = 0.005;
    }
  }

  resetStats() {
    this.emaMean = 0;
    this.emaVar = 0;
    this.smoothedFlux = 0;
    this.prevSmoothedFlux = 0;
    this.statsInitialized = false;
  }

  getTriggerRange() {
    if (this.mode === "Auto Beat") return [this.bandStart, this.bandEnd];
    const freqIndex = this.freqIndex >= 0 ? this.freqIndex : Math.floor(0.2 * 64);
    return [Math.max(0, freqIndex - 1), Math.min(63, freqIndex + 1)];
  }
}

/**
 * 音频引擎 — 立体声合并 64-bin 零分配分析 + AGC 软压缩 + 新帧驱动节拍检测
 */
class AudioEngine {
  constructor() {
    this.idleFadeOutDuration = 1;
    this.lastActiveTime = 0;
    this.lastIdleTime = 0;
    this.idleEnergyThreshold = 0.015;
    this.currentIdleIntensity = 0;
    this.debounceDuration = 1;
    this.idleStartTime = 0;

    // 原始 128-bin 立体声缓存（兼容 getWallpaperAudioData）与合并后 64-bin 频谱
    this.wallpaperAudioData = new Float32Array(128);
    this.mono64 = new Float32Array(64);
    this.prevMono64 = new Float32Array(64);
    this.wallpaperAudioReceived = false;
    this.audioDirty = false;
    this.lastPacketMs = 0;
    this.packetDt = 1 / 30;
    this.smoothedZeroed = true;

    // 慢追踪自动增益参考电平（保留乐段强弱动态，防止大音量削顶或小音量无响应）
    this.agcLevel = 0.32;
    this.prevBrightness = 0;
    this.stereoPan = 0;

    // 最新目标频段值（仅在收到新音频帧时重算，高刷渲染帧直接平滑插值）
    this.targetData = {
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      subBass: 0,
      lowMid: 0,
      highMid: 0,
      presence: 0,
      brilliance: 0,
      air: 0,
      warmth: 0,
      brightness: 0,
      sharpness: 0,
      smoothness: 1,
      density: 0,
      stereoPan: 0,
    };

    this.smoothedData = {
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      subBass: 0,
      lowMid: 0,
      highMid: 0,
      presence: 0,
      brilliance: 0,
      air: 0,
      warmth: 0,
      brightness: 0,
      sharpness: 0,
      smoothness: 1,
      density: 0,
      stereoPan: 0,
    };

    this.pulseTrigger = new BeatTrigger("Pulse");
    this.meteorTrigger = new BeatTrigger("Meteor");
  }

  /**
   * 仅在新音频帧到达时推进节拍统计与峰值检测（高刷屏无零帧污染）
   */
  evaluateTriggerOnPacket(trigger, normFlux, rawFlux, rawEnergy, mono64, packetDt, pan) {
    if (!trigger.enabled) return;

    if (trigger.mode === "Advanced") {
      const [start, end] = trigger.getTriggerRange();
      let sum = 0;
      let count = 0;
      for (let i = start; i <= end; i++) {
        sum += mono64[i] || 0;
        count++;
      }
      const energy = count > 0 ? sum / count : 0;
      if (trigger.currentCooldown <= 0 && energy > trigger.threshold) {
        if (this.onFreqTrigger) this.onFreqTrigger(energy, "Advanced", trigger.action, pan);
        trigger.currentCooldown = Math.max(12, trigger.cooldown || 30);
      }
      return;
    }

    if (trigger.mode === "Auto Beat") {
      // 约 25ms 轻度瞬态平滑，滤除高频毛刺同时保留鼓点冲击锐度
      const fluxAlpha = 1 - Math.exp(-packetDt / 0.025);
      trigger.smoothedFlux += (normFlux - trigger.smoothedFlux) * fluxAlpha;

      // 约 0.85s 时间窗口的指数均值与方差（与音频回调频率和屏幕刷新率完全无关）
      const statBeta = 1 - Math.exp(-packetDt / 0.85);
      if (!trigger.statsInitialized) {
        trigger.emaMean = trigger.smoothedFlux;
        trigger.emaVar = 0;
        trigger.statsInitialized = true;
      } else {
        const diff = trigger.smoothedFlux - trigger.emaMean;
        trigger.emaMean += statBeta * diff;
        trigger.emaVar = (1 - statBeta) * (trigger.emaVar + statBeta * diff * diff);
      }

      const stdDev = Math.sqrt(Math.max(0, trigger.emaVar));
      // 适配 project.json 滑块范围：Pulse(0.05..0.5, 默认0.2 -> k=1.52) / Meteor(0.1..0.8, 默认0.35 -> k=1.16)
      const k = Math.max(0.2, 2.0 - trigger.sensitivity * 2.4);
      const threshold = Math.max(0.08, trigger.emaMean + stdDev * k);

      const isPeak =
        trigger.prevSmoothedFlux > threshold &&
        trigger.prevSmoothedFlux >= trigger.smoothedFlux &&
        trigger.prevSmoothedFlux - trigger.smoothedFlux > 1e-3;

      const passesFloor = rawEnergy >= trigger.minRawEnergy || rawFlux >= trigger.minRawFlux;

      if (trigger.beatHold <= 0 && isPeak && passesFloor) {
        // 按超阈倍率 + 绝对通量综合映射为保留强弱层次的标准化力度 [0.25 .. 1.5]
        const excess = (trigger.prevSmoothedFlux - threshold) / (stdDev + 0.15);
        const normIntensity = Math.min(
          1.5,
          0.26 + (excess / (1.0 + excess * 0.65)) * 0.85 + Math.min(0.4, trigger.prevSmoothedFlux * 0.25),
        );
        if (this.onFreqTrigger) {
          this.onFreqTrigger(normIntensity * (0.7 + trigger.pulseStrength), "Kick", trigger.action, pan);
        }
        trigger.beatHold = trigger.cooldown;
      }

      trigger.prevSmoothedFlux = trigger.smoothedFlux;
    }
  }

  /**
   * 接收 Wallpaper Engine 音频数组：
   *   - 128-bin 标准格式：[0..63] 左声道 + [64..127] 右声道 -> 立体声均值合并为 64-bin
   *   - 64-bin 格式：直接拷贝
   */
  setWallpaperAudioData(data) {
    const now = performance.now();
    if (!this.wallpaperAudioReceived) {
      this.lastActiveTime = now;
      this.lastIdleTime = 0;
      this.lastPacketMs = now;
      this.packetDt = 1 / 30;
    } else {
      const dtSec = (now - this.lastPacketMs) * 0.001;
      if (dtSec > 0.004) {
        this.packetDt = Math.min(0.2, Math.max(0.008, dtSec));
        this.lastPacketMs = now;
      }
    }

    this.wallpaperAudioReceived = true;
    const len = data?.length || 0;
    const dst128 = this.wallpaperAudioData;
    const m64 = this.mono64;
    let lSum = 0;
    let rSum = 0;

    if (len === 128) {
      for (let i = 0; i < 64; i++) {
        const lRaw = data[i];
        const rRaw = data[64 + i];
        const l = lRaw > 0 ? lRaw : 0;
        const r = rRaw > 0 ? rRaw : 0;
        dst128[i] = l;
        dst128[64 + i] = r;
        m64[i] = (l + r) * 0.5;
        lSum += l;
        rSum += r;
      }
    } else if (len === 64) {
      for (let i = 0; i < 64; i++) {
        const vRaw = data[i];
        const v = vRaw > 0 ? vRaw : 0;
        dst128[i] = v;
        dst128[64 + i] = v;
        m64[i] = v;
        lSum += v;
        rSum += v;
      }
    } else if (len > 0) {
      const half = len >> 1;
      for (let i = 0; i < 64; i++) {
        const idx = Math.floor((i * half) / 64);
        const lRaw = data[idx];
        const rRaw = data[half + idx];
        const l = lRaw > 0 ? lRaw : 0;
        const r = rRaw > 0 ? rRaw : 0;
        dst128[i] = l;
        dst128[64 + i] = r;
        m64[i] = (l + r) * 0.5;
        lSum += l;
        rSum += r;
      }
    } else {
      dst128.fill(0);
      m64.fill(0);
    }

    const totalLR = lSum + rSum;
    this.stereoPan = totalLR > 1e-4 ? (rSum - lSum) / totalLR : 0;
    this.audioDirty = true;
  }

  getWallpaperAudioData() {
    return this.wallpaperAudioData;
  }

  getAudioData(dt = 0.016) {
    if (!this.wallpaperAudioReceived) {
      return this.smoothedData;
    }

    // 冷却按真实渲染时间倒计时（单位沿用 60fps 帧数以兼容 project.json 配置）
    const frameStep = dt * 60;
    if (this.pulseTrigger.beatHold > 0) {
      this.pulseTrigger.beatHold = Math.max(0, this.pulseTrigger.beatHold - frameStep);
    }
    if (this.pulseTrigger.currentCooldown > 0) {
      this.pulseTrigger.currentCooldown = Math.max(0, this.pulseTrigger.currentCooldown - frameStep);
    }
    if (this.meteorTrigger.beatHold > 0) {
      this.meteorTrigger.beatHold = Math.max(0, this.meteorTrigger.beatHold - frameStep);
    }
    if (this.meteorTrigger.currentCooldown > 0) {
      this.meteorTrigger.currentCooldown = Math.max(0, this.meteorTrigger.currentCooldown - frameStep);
    }

    const m64 = this.mono64;
    const td = this.targetData;
    const sd = this.smoothedData;

    // 仅在收到新音频包时执行频谱分析与 Flux 节拍检测
    if (this.audioDirty) {
      this.audioDirty = false;
      const prev64 = this.prevMono64;
      const pDt = this.packetDt;

      let sum64 = 0;
      let sumSq64 = 0;
      let deltaTotal64 = 0;

      // 非重叠感知频段累加（64-bin 立体声合并）
      let subBassSum = 0;   // b0..b2   (3)
      let bassSum = 0;      // b3..b7   (5)
      let lowMidSum = 0;    // b8..b15  (8)
      let midSum = 0;       // b16..b26 (11)
      let highMidSum = 0;   // b27..b39 (13)
      let trebleSum = 0;    // b40..b53 (14)
      let airSum = 0;       // b54..b63 (10)
      let presenceSum = 0;  // b24..b35 (12, 兼容保留)
      let brillianceSum = 0;// b36..b51 (16, 兼容保留)

      let pulsePosFlux = 0;
      let pulseBandSum = 0;
      let meteorPosFlux = 0;
      let meteorBandSum = 0;

      const pStart = this.pulseTrigger.bandStart;
      const pEnd = this.pulseTrigger.bandEnd;
      const mStart = this.meteorTrigger.bandStart;
      const mEnd = this.meteorTrigger.bandEnd;

      for (let b = 0; b < 64; b++) {
        const val = m64[b];
        sum64 += val;
        sumSq64 += val * val;

        const delta = val - prev64[b];
        deltaTotal64 += delta >= 0 ? delta : -delta;

        if (b <= 2) subBassSum += val;
        else if (b <= 7) bassSum += val;
        else if (b <= 15) lowMidSum += val;
        else if (b <= 26) midSum += val;
        else if (b <= 39) highMidSum += val;
        else if (b <= 53) trebleSum += val;
        else airSum += val;

        if (b >= 24 && b <= 35) presenceSum += val;
        if (b >= 36 && b <= 51) brillianceSum += val;

        if (b >= pStart && b <= pEnd) {
          pulseBandSum += val;
          if (delta > 0) pulsePosFlux += delta;
        }
        if (b >= mStart && b <= mEnd) {
          meteorBandSum += val;
          if (delta > 0) meteorPosFlux += delta;
        }

        prev64[b] = val;
      }

      const avg64 = sum64 * (1 / 64);
      const rms64 = Math.sqrt(sumSq64 * (1 / 64));

      if (avg64 > this.idleEnergyThreshold) {
        this.lastActiveTime = performance.now();
      } else {
        this.lastIdleTime = performance.now();
      }

      // 静默完全收敛短路
      if (sum64 === 0 && deltaTotal64 === 0 && this.smoothedZeroed) {
        this.pulseTrigger.resetStats();
        this.meteorTrigger.resetStats();
        return sd;
      }

      // 慢追踪自动增益（快攻 0.35s 抗爆音，慢释 3.5s 保留安静乐段动态）
      const targetAgc = Math.max(0.12, rms64 * 1.15);
      const agcTau = targetAgc > this.agcLevel ? 0.35 : 3.5;
      const agcAlpha = 1 - Math.exp(-pDt / agcTau);
      this.agcLevel += (targetAgc - this.agcLevel) * agcAlpha;
      const agcRef = Math.max(0.12, this.agcLevel);

      // 节拍触发评估（按频段宽度与 AGC 归一化，跨曲风/跨音量稳定触发）
      const pCount = Math.max(1, pEnd - pStart + 1);
      const mCount = Math.max(1, mEnd - mStart + 1);
      const pulseRawFlux = pulsePosFlux / pCount;
      const pulseRawEnergy = pulseBandSum / pCount;
      const meteorRawFlux = meteorPosFlux / mCount;
      const meteorRawEnergy = meteorBandSum / mCount;

      this.evaluateTriggerOnPacket(
        this.pulseTrigger,
        pulseRawFlux / agcRef,
        pulseRawFlux,
        pulseRawEnergy,
        m64,
        pDt,
        this.stereoPan,
      );
      this.evaluateTriggerOnPacket(
        this.meteorTrigger,
        (meteorRawFlux * 1.65) / agcRef,
        meteorRawFlux,
        meteorRawEnergy,
        m64,
        pDt,
        this.stereoPan,
      );

      // 原始频段均值
      const subBassRaw = subBassSum * (1 / 3);
      const bassRaw = bassSum * (1 / 5);
      const lowMidRaw = lowMidSum * (1 / 8);
      const midRaw = midSum * (1 / 11);
      const highMidRaw = highMidSum * (1 / 13);
      const trebleRaw = trebleSum * (1 / 14);
      const airRaw = airSum * (1 / 10);
      const presenceRaw = presenceSum * (1 / 12);
      const brillianceRaw = brillianceSum * (1 / 16);

      // 软拐点压缩 + 感知高频补偿（抵消自然音乐 1/f 高频衰减）
      td.subBass = softCompress(subBassRaw, agcRef, 0.85);
      td.bass = softCompress(bassRaw, agcRef, 0.98);
      td.lowMid = softCompress(lowMidRaw, agcRef, 1.12);
      td.mid = softCompress(midRaw, agcRef, 1.28);
      td.highMid = softCompress(highMidRaw, agcRef, 1.48);
      td.treble = softCompress(trebleRaw, agcRef, 1.72);
      td.air = softCompress(airRaw, agcRef, 1.95);
      td.presence = softCompress(presenceRaw, agcRef, 1.4);
      td.brilliance = softCompress(brillianceRaw, agcRef, 1.65);
      td.energy = softCompress(rms64, agcRef, 1.0);

      // 纯立体声合并频谱的冷暖色温与亮度占比（无跨声道污染）
      const warmth = sum64 > 1e-5 ? (subBassSum + bassSum + lowMidSum) / sum64 : 0;
      const brightness = sum64 > 1e-5 ? (highMidSum + trebleSum + airSum) / sum64 : 0;
      const sharpness = Math.min(1, Math.max(0, (brightness - this.prevBrightness) * 8));
      this.prevBrightness = brightness;

      // 归一化平滑度（不受绝对音量幅值干扰）
      const normDelta = deltaTotal64 / (sum64 + 0.25);
      const smoothness = Math.max(0, Math.min(1, 1 - normDelta * 1.1));

      // 7 频段活跃密度（精确归一化到 0..1）
      const activeThresh = avg64 * 1.2;
      let activeCount = 0;
      if (subBassRaw > activeThresh) activeCount++;
      if (bassRaw > activeThresh) activeCount++;
      if (lowMidRaw > activeThresh) activeCount++;
      if (midRaw > activeThresh) activeCount++;
      if (highMidRaw > activeThresh) activeCount++;
      if (trebleRaw > activeThresh) activeCount++;
      if (airRaw > activeThresh) activeCount++;

      td.warmth = warmth;
      td.brightness = brightness;
      td.sharpness = sharpness;
      td.smoothness = smoothness;
      td.density = activeCount / 7;
      td.stereoPan = this.stereoPan;
    } else if (this.smoothedZeroed) {
      return sd;
    }

    // 非对称快启慢落平滑（每渲染帧推进，高刷屏丝滑且瞬态响应利落）
    const atkFast = 1 - Math.pow(1 - 0.34, frameStep);
    const relFast = 1 - Math.pow(1 - 0.11, frameStep);
    const atkSub = 1 - Math.pow(1 - 0.24, frameStep);
    const relSub = 1 - Math.pow(1 - 0.08, frameStep);
    const smoothStat = 1 - Math.pow(1 - 0.12, frameStep);

    sd.subBass += (td.subBass - sd.subBass) * (td.subBass > sd.subBass ? atkSub : relSub);
    sd.bass += (td.bass - sd.bass) * (td.bass > sd.bass ? atkFast : relFast);
    sd.lowMid += (td.lowMid - sd.lowMid) * (td.lowMid > sd.lowMid ? atkFast : relFast);
    sd.mid += (td.mid - sd.mid) * (td.mid > sd.mid ? atkFast : relFast);
    sd.highMid += (td.highMid - sd.highMid) * (td.highMid > sd.highMid ? atkFast : relFast);
    sd.treble += (td.treble - sd.treble) * (td.treble > sd.treble ? atkFast : relFast);
    sd.air += (td.air - sd.air) * (td.air > sd.air ? atkFast : relFast);
    sd.presence += (td.presence - sd.presence) * (td.presence > sd.presence ? atkFast : relFast);
    sd.brilliance += (td.brilliance - sd.brilliance) * (td.brilliance > sd.brilliance ? atkFast : relFast);
    sd.energy += (td.energy - sd.energy) * (td.energy > sd.energy ? atkFast : relFast);

    sd.warmth += (td.warmth - sd.warmth) * smoothStat;
    sd.brightness += (td.brightness - sd.brightness) * smoothStat;
    sd.sharpness += (td.sharpness - sd.sharpness) * smoothStat;
    sd.smoothness += (td.smoothness - sd.smoothness) * smoothStat;
    sd.density += (td.density - sd.density) * smoothStat;
    sd.stereoPan += (td.stereoPan - sd.stereoPan) * smoothStat;

    if (
      td.energy === 0 &&
      sd.energy < 1e-4 &&
      sd.subBass < 1e-4 &&
      sd.bass < 1e-4 &&
      sd.mid < 1e-4 &&
      sd.treble < 1e-4 &&
      sd.highMid < 1e-4 &&
      sd.lowMid < 1e-4 &&
      sd.air < 1e-4
    ) {
      sd.bass = sd.mid = sd.treble = sd.energy = sd.subBass = sd.lowMid = 0;
      sd.highMid = sd.presence = sd.brilliance = sd.air = 0;
      sd.warmth = sd.brightness = sd.sharpness = sd.density = sd.stereoPan = 0;
      this.smoothedZeroed = true;
    } else {
      this.smoothedZeroed = false;
    }

    return sd;
  }

  getIdleWaveIntensity(dt = 0.016) {
    const now = performance.now();
    let target;
    if (this.wallpaperAudioReceived) {
      if (this.lastActiveTime > this.lastIdleTime) {
        target = 0;
        this.idleStartTime = 0;
      } else {
        if (this.idleStartTime === 0) this.idleStartTime = now;
        target = (now - this.idleStartTime) / 1000 >= this.debounceDuration ? 1 : 0;
      }
    } else {
      target = 1;
    }
    const step = (1 / this.idleFadeOutDuration) * dt;
    if (target > this.currentIdleIntensity) {
      this.currentIdleIntensity = Math.min(target, this.currentIdleIntensity + step);
    } else if (target < this.currentIdleIntensity) {
      this.currentIdleIntensity = Math.max(target, this.currentIdleIntensity - step);
    }
    return this.currentIdleIntensity;
  }

  setIdleWaveDebounce(duration) {
    this.debounceDuration = duration;
  }

  setIdleFadeOutDuration(duration) {
    this.idleFadeOutDuration = duration;
  }
}

const audioEngine = new AudioEngine();

export { BeatTrigger, AudioEngine, audioEngine };
