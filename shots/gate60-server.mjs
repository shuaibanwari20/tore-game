/** up60 gate proof server — the worker's gate + ticket routes with
 *  the shapes verified in worker.js/auth.js: GET / -> 401 + the
 *  REAL gatePage() HTML; POST /auth/ticket -> {ok, ticket};
 *  GET /auth/ticket-status -> {ok:false} twice, then {ok:true,user}
 *  WITH a Set-Cookie (the session landing in this context);
 *  GET /auth/google -> a placeholder flow page; /auth/me -> 401;
 *  /auth/config -> {fbLive:false}. POST /__mode zeroes counters. */
import http from 'node:http';
import { gatePage } from '/home/hatch/workspace/projects/tore-game/cloudflare/src/gate-page.js';

const TICKET = '0123456789abcdef0123456789abcdef';
let rootHits = 0;
let statusHits = 0;
let ticketHits = 0;
const html = gatePage();

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    rootHits++;
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (u.pathname === '/auth/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"fbLive":false}');
    return;
  }
  if (u.pathname === '/auth/me') {
    res.writeHead(401);
    res.end('unauthorized');
    return;
  }
  if (u.pathname === '/auth/ticket' && req.method === 'POST') {
    ticketHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ticket: TICKET }));
    return;
  }
  if (u.pathname === '/auth/ticket-status') {
    statusHits++;
    if (statusHits >= 3 && u.searchParams.get('ticket') === TICKET) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'tore_session=proof-cookie; Path=/; HttpOnly',
      });
      res.end('{"ok":true,"user":{"provider":"google","sub":"12345","name":"Proof User"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":false}');
    return;
  }
  if (u.pathname === '/auth/google') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<title>google-flow</title><p>placeholder for the Google flow</p>');
    return;
  }
  if (u.pathname === '/__mode') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      rootHits = 0;
      statusHits = 0;
      ticketHits = 0;
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }
  if (u.pathname === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rootHits, statusHits, ticketHits }));
    return;
  }
  res.writeHead(404);
  res.end('nf');
});
server.listen(8912, '127.0.0.1', () => console.log('gate60 server on 8912'));
