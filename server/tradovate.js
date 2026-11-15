// Sincronización con la API de Tradovate (solo lectura: ejecuciones, órdenes, cuentas y comisiones).

const HOSTS = {
  live: 'https://live.tradovateapi.com/v1',
  demo: 'https://demo.tradovateapi.com/v1',
};
const FEE_FIELDS = ['clearingFee', 'exchangeFee', 'nfaFee', 'brokerageFee', 'ipFee', 'commission', 'orderRoutingFee'];

export function tradovateConfig(env = process.env) {
  const cfg = {
    env: (env.TRADOVATE_ENV || 'live').trim().toLowerCase() === 'demo' ? 'demo' : 'live',
    name: env.TRADOVATE_USER || '', password: env.TRADOVATE_PASSWORD || '',
    cid: env.TRADOVATE_CID || '', sec: env.TRADOVATE_SEC || '',
    appId: env.TRADOVATE_APP_ID || 'DiarioDeTrading',
    minutes: Math.max(1, Number(env.SYNC_MINUTES) || 5),
  };
  cfg.configured = !!(cfg.name && cfg.password && cfg.cid && cfg.sec);
  return cfg;
}

export class TradovateSync {
  constructor(cfg, store, fetchImpl = fetch) {
    this.cfg = cfg; this.store = store; this.fetch = fetchImpl;
    this.token = null; this.tokenExp = 0; this.contracts = new Map();
    this.status = { configured: cfg.configured, env: cfg.env, running: false, lastRun: null, lastOk: null, lastError: null, lastAdded: 0 };
    this.timer = null;
  }

  async #token() {
    if (this.token && Date.now() < this.tokenExp - 5 * 60_000) return this.token;
    const res = await this.fetch(`${HOSTS[this.cfg.env]}/auth/accesstokenrequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name: this.cfg.name, password: this.cfg.password, appId: this.cfg.appId, appVersion: '1.0',
        cid: this.cfg.cid, sec: this.cfg.sec, deviceId: 'diario-de-trading',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (body['p-ticket']) {
      throw new Error(body['p-captcha']
        ? 'Tradovate pide verificación (captcha). Inicia sesión una vez en Tradovate y reintenta.'
        : `Tradovate pide esperar ${body['p-time'] || 'unos'} segundos antes de reintentar.`);
    }
    if (!res.ok || body.errorText || !body.accessToken) {
      throw new Error(`Tradovate rechazó las credenciales: ${body.errorText || `HTTP ${res.status}`}`);
    }
    this.token = body.accessToken;
    this.tokenExp = body.expirationTime ? Date.parse(body.expirationTime) : Date.now() + 60 * 60_000;
    return this.token;
  }

  async #get(path) {
    const token = await this.#token();
    const res = await this.fetch(`${HOSTS[this.cfg.env]}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.status === 401) { this.token = null; throw new Error('La sesión de Tradovate expiró; se renovará en el próximo intento.'); }
    if (!res.ok) throw new Error(`Tradovate respondió HTTP ${res.status} en ${path}`);
    return res.json();
  }

  /** Descarga las ejecuciones y las guarda. Devuelve { added, total }. */
  async run() {
    if (!this.cfg.configured) throw new Error('Faltan las credenciales de Tradovate en el archivo .env.');
    if (this.status.running) return { added: 0, total: 0, skipped: true };
    this.status.running = true;
    this.status.lastRun = new Date().toISOString();
    try {
      const [fills, orders, accounts] = await Promise.all([
        this.#get('/fill/list'), this.#get('/order/list'), this.#get('/account/list'),
      ]);
      const fees = await this.#get('/fillFee/list').catch(() => []);
      const accountName = new Map(accounts.map((a) => [a.id, a.name]));
      const orderAccount = new Map(orders.map((o) => [o.id, o.accountId]));
      const feeById = new Map(fees.map((f) => [f.id, FEE_FIELDS.reduce((s, k) => s + (Number(f[k]) || 0), 0)]));

      const missing = [...new Set(fills.map((f) => f.contractId))].filter((id) => !this.contracts.has(id));
      for (let i = 0; i < missing.length; i += 50) {
        const items = await this.#get(`/contract/items?ids=${missing.slice(i, i + 50).join(',')}`);
        for (const c of items) this.contracts.set(c.id, c.name);
      }

      const fallbackAccount = accounts.length === 1 ? accounts[0].name : 'Tradovate';
      const mapped = [];
      for (const f of fills) {
        if (f.active === false) continue;
        const contract = this.contracts.get(f.contractId);
        if (!contract || !(f.qty > 0)) continue;
        mapped.push({
          id: `tv-${f.id}`,
          account: accountName.get(orderAccount.get(f.orderId)) || fallbackAccount,
          contract: String(contract).toUpperCase(),
          side: f.action === 'Buy' ? 'B' : 'S',
          qty: f.qty, price: f.price, ts: new Date(f.timestamp).toISOString(),
          fee: feeById.has(f.id) ? feeById.get(f.id) : null, source: 'api',
        });
      }
      const { added } = this.store.addFills(mapped, { authoritative: true });
      Object.assign(this.status, { lastOk: new Date().toISOString(), lastError: null, lastAdded: added });
      return { added, total: mapped.length };
    } catch (e) {
      this.status.lastError = e.message;
      throw e;
    } finally {
      this.status.running = false;
    }
  }

  start() {
    if (!this.cfg.configured || this.timer) return;
    const tick = () => this.run().catch((e) => console.error(`[sync] ${e.message}`));
    tick();
    this.timer = setInterval(tick, this.cfg.minutes * 60_000);
    this.timer.unref?.();
  }
}
