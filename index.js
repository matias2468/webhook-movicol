const express = require('express');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json());

const WOMPI_SECRET = process.env.WOMPI_EVENTS_SECRET;
const FIREBASE_DB = 'https://gaitan-movil-default-rtdb.firebaseio.com';
const FIREBASE_SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

let firebaseToken = null;
let tokenExpiry = 0;

async function getFirebaseToken() {
  if (firebaseToken && Date.now() < tokenExpiry - 60000) return firebaseToken;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: FIREBASE_SA.client_email,
    sub: FIREBASE_SA.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email'
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(FIREBASE_SA.private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;
  const tokenData = await new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  firebaseToken = tokenData.access_token;
  tokenExpiry = Date.now() + (tokenData.expires_in * 1000);
  return firebaseToken;
}

async function firebaseGet(path) {
  const token = await getFirebaseToken();
  return new Promise((resolve, reject) => {
    https.get(`${FIREBASE_DB}/${path}.json?access_token=${token}`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function firebasePatch(path, data) {
  const token = await getFirebaseToken();
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gaitan-movil-default-rtdb.firebaseio.com',
      path: `/${path}.json?access_token=${token}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/webhook', async (req, res) => {
  try {
    console.log('Evento Wompi recibido:', JSON.stringify(req.body).substring(0, 200));
    const evento = req.body;
    if (evento.event === 'transaction.updated' && evento.data?.transaction?.status === 'APPROVED') {
      const tx = evento.data.transaction;
      const monto = tx.amount_in_cents / 100;
      const referencia = tx.reference || '';
      console.log(`Pago aprobado: $${monto} ref: ${referencia}`);
      const matchCel = referencia.match(/(\d{10})/);
      const celular = matchCel ? matchCel[1] : null;
      if (celular) {
        const aliado = await firebaseGet(`aliadoes/${celular}`);
        const saldoActual = (aliado && aliado.saldo) ? aliado.saldo : 0;
        const saldoNuevo = saldoActual + monto;
        await firebasePatch(`aliadoes/${celular}`, { saldo: saldoNuevo });
        console.log(`${celular}: $${saldoActual} + $${monto} = $${saldoNuevo}`);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'MOVICOL Webhook activo', hora: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook MOVICOL en puerto ${PORT}`));
