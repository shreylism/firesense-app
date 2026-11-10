let ac, osc, iv;
export function unlockAudio() {
  try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); } catch {}
}
export function startAlarm(text) {
  stopAlarm();
  try {
    unlockAudio();
    osc = ac.createOscillator();
    const g = ac.createGain(); g.gain.value = 0.15;
    osc.type = "square"; osc.connect(g); g.connect(ac.destination); osc.start();
  } catch {}
  let f = 0;
  iv = setInterval(() => {
    f ^= 1;
    if (osc) osc.frequency.value = f ? 880 : 660;
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  }, 500);
  try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text || "Fire detected. Please evacuate.")); } catch {}
}
export function stopAlarm() {
  clearInterval(iv);
  try { osc && osc.stop(); } catch {}
  osc = null;
  try { navigator.vibrate && navigator.vibrate(0); speechSynthesis.cancel(); } catch {}
}