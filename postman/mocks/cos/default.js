// Tencent COS REST/CI contract subset; private data is synthetic, unsupported operations return 501.
const http = require('node:http');
const objects = new Map([['tmp/test', Buffer.from('fake image bytes')], ['invalid', Buffer.from('invalid')], ['video', Buffer.from('video')]]);
let failDeletion = false;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock'), key = decodeURIComponent(url.pathname.replace(/^\/cos\//, "/").slice(1));
  if (req.method === 'POST' && key === '_test/delete-failure') {
    let body = ''; for await (const c of req) body += c;
    failDeletion = JSON.parse(body).enabled === true;
    res.writeHead(204); return res.end();
  }
  if (req.method === 'DELETE' && failDeletion && key === 'media/f/a') {
    res.writeHead(503, { 'Content-Type': 'application/xml' });
    return res.end('<Error><Code>ServiceUnavailable</Code><Message>synthetic failure</Message></Error>');
  }
  if (req.method === 'POST' && key === 'sts/') {
    let body = ''; for await (const c of req) body += c;
    const data = JSON.parse(body), policy = JSON.parse(data.Policy);
    if (req.headers['x-tc-action'] !== 'GetFederationToken' || policy.statement[0].action.join() !== 'name/cos:PostObject') { res.writeHead(400); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ Response: { Credentials: { TmpSecretId: 'temporary', TmpSecretKey: 'secret-for-test', Token: 'session' }, ExpiredTime: Math.floor(Date.now() / 1000) + data.DurationSeconds, RequestId: 'test' } }));
  }
  if (key === 'upstream-error') { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('<h1>unavailable</h1>'); }
  if (req.method === 'HEAD') {
    if (!objects.has(key)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Length': objects.get(key).length, ETag: '"test-etag"' }); return res.end();
  }
  if (req.method === 'PUT') {
    const copy = req.headers['x-cos-copy-source'];
    if (copy) {
      const source = copy.slice(copy.indexOf('/') + 1);
      if (!objects.has(source)) { res.writeHead(404); return res.end(); }
      if (req.headers['x-cos-copy-source-if-match'] !== '"test-etag"') { res.writeHead(412); return res.end(); }
      objects.set(key, Buffer.from(objects.get(source)));
      res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end('<CopyObjectResult><ETag>"test-etag"</ETag></CopyObjectResult>');
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"test-etag"' }); return res.end();
  }
  if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && url.searchParams.has('imageInfo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ format: key === 'invalid' ? 'svg' : 'jpeg', width: '100', height: '100' }));
  }
  if (req.method === 'GET' && url.searchParams.get('ci-process') === 'videoinfo') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end('<Response><MediaInfo><Format><FormatName>mov,mp4,m4a,3gp,3g2,mj2</FormatName></Format><Stream><Video><Width>640</Width><Height>480</Height></Video></Stream></MediaInfo></Response>');
  }
  if (req.method === 'GET' && (url.search.includes('imageMogr2') || url.searchParams.get('ci-process') === 'snapshot')) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.from([255,216,255,217]));
  }
  if (req.method === 'GET' && !url.searchParams.has('ci-process') && objects.has(key)) {
    if (req.headers['if-match'] !== '"test-etag"') { res.writeHead(412); return res.end(); }
    res.writeHead(200, { 'Content-Length': objects.get(key).length }); return res.end(objects.get(key));
  }
  res.writeHead(501); res.end('Endpoint not defined');
}).listen(process.env.PORT, '127.0.0.1');
