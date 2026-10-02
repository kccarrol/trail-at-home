/* Test double for Web Bluetooth: a pretend Bowflex VeloCore.
   Injected into the page before the app loads (Playwright add_init_script). It reports itself as
   a Fitness Machine (FTMS) and sends Indoor Bike Data once a second with cadence and power.
   Tests drive it through window.__bt:
     __bt.power = 200   watts in the next notifications
     __bt.cad = 80      cadence in rpm
     __bt.drop()        the bike disconnects and refuses to reconnect
     __bt.restore()     the bike accepts reconnects again */
(() => {
  const bt = window.__bt = { power: 0, cad: 80, allow: true, notes: 0 };
  const ch = new EventTarget(), svc = { getCharacteristic: async () => ch };
  let iv = null;
  ch.startNotifications = async () => {
    clearInterval(iv);
    iv = setInterval(() => {
      // Indoor Bike Data: flags = more data (no speed) | cadence | power
      const v = new DataView(new ArrayBuffer(8));
      v.setUint16(0, 1 | 4 | 64, true); v.setUint16(2, bt.cad * 2, true); v.setInt16(4, bt.power, true);
      ch.value = v; bt.notes++; ch.dispatchEvent(new Event("characteristicvaluechanged"));
    }, 1000);
    return ch;
  };
  const server = { getPrimaryService: async u => { if (u === 0x1826) return svc; throw new Error("not offered"); } };
  const dev = new EventTarget(); dev.name = "VeloCore";
  dev.gatt = { connected: false,
    connect: async () => { if (!bt.allow) throw new Error("out of range"); dev.gatt.connected = true; return server; },
    disconnect: () => { clearInterval(iv); dev.gatt.connected = false; dev.dispatchEvent(new Event("gattserverdisconnected")); } };
  bt.drop = () => { bt.allow = false; clearInterval(iv); dev.gatt.connected = false; dev.dispatchEvent(new Event("gattserverdisconnected")); };
  bt.restore = () => { bt.allow = true; };
  Object.defineProperty(navigator, "bluetooth", { value: { requestDevice: async () => dev }, configurable: true });
})();
