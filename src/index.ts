//------------------- types needed--------------
type HTTPReq = {
  method: string;
  uri: Buffer;
  version: string;
  headers: Buffer[];
};

type HTTPRes = {
  code: number;
  headers: Buffer[];
  Body: BodyReader;
};
type BodyReader = {
  length: number;
  read: () => Promise<Buffer>;
};

type DynBuf = {
  data: Buffer;
  length: number;
};

type TCPConn = {
  socket: net.Socket;
  err: null | Error;
  ended: boolean;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};
//-----------------------------------------------//
//------------------ The Server Loop ------------//
import net from "net";
async function serverClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  while (true) {
    const msg: null | HTTPReq = cutMessage(buf);
    if (!msg) {
      const data = await soRead(conn);
      bufPush(buf, data);
      if (data.length === 0 && buf.length === 0) {
        return;
      }
      if (data.length === 0) {
        throw new HTTPError(400, "Unexpected EOF.");
      }
      continue;
    }

    const reqBody: BodyReader = readerFromReq(conn, buf, msg);
    const res: HTTPRes = await handleReq(meg, reqBody);
    await writeHTTPResp =await handleReq(msg, reqBody);
    await writeHTTPResp(conn,res);
    if(msg.version === '1.0'){
        return;
    }
    while ((await reqBody.read()).length > 0) { /* empty */ }
  }
}

async function newConn(socket: net.Socket): Promise<void> {
    const conn: TCPConn = soInit(socket);
    try {
        await serveClient(conn);
    } catch (exc) {
        console.error('exception:', exc);
        if (exc instanceof HTTPError) {
            const resp: HTTPRes = {
                code: exc.code,
                headers: [],
                body: readerFromMemory(Buffer.from(exc.message + '\n')),
            };
            try {
                await writeHTTPResp(conn, resp);
            } catch (exc) { /* ignore */ }
        }
    } finally {
        socket.destroy();
    }
}

//------------------------------------------------------//
//-------------------- Split Header --------------------//
// We detect /n/r
const kMaxHeaderLen = 1024 * 8;

function cutMessage(buf: DynBuf): null|HTTPReq {
    const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
    if (idx < 0) {
        if (buf.length >= kMaxHeaderLen) {
            throw new HTTPError(413, 'header is too large');
        }
        return null;    // need more data
    }
    const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
    bufPop(buf, idx + 4);
    return msg;
}
//------------------------------------------------------//
//-------------------- Parse the Header --------------------//
function parseHTTPReq(data: Buffer): HTTPReq {
    const lines: Buffer[] = splitLines(data);
    const [method, uri, version] = parseRequestLine(lines[0]);
    const headers: Buffer[] = [];
    for (let i = 1; i < lines.length - 1; i++) {
        const h = Buffer.from(lines[i]);    // copy
        if (!validateHeader(h)) {
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h);
    }
    console.assert(lines[lines.length - 1].length === 0);
    return {
        method: method, uri: uri, version: version, headers: headers,
    };
}
//------------------------------------------------------//
//------------------- Read the Body --------------------//
function readerFromReq(
    conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader
{
    let bodyLen = -1;
    const contentLen = fieldGet(req.headers, 'Content-Length');
    if (contentLen) {
        bodyLen = parseDec(contentLen.toString('latin1'));
        if (isNaN(bodyLen)) {
            throw new HTTPError(400, 'bad Content-Length.');
        }
    }
    const bodyAllowed = !(req.method === 'GET' || req.method === 'HEAD');
    const chunked = fieldGet(req.headers, 'Transfer-Encoding')
        ?.equals(Buffer.from('chunked')) || false;
    if (!bodyAllowed && (bodyLen > 0 || chunked)) {
        throw new HTTPError(400, 'HTTP body not allowed.');
    }
    if (!bodyAllowed) {
        bodyLen = 0;
    }

    if (bodyLen >= 0) {
        return readerFromConnLength(conn, buf, bodyLen);
    } else if (chunked) {
        throw new HTTPError(501, 'TODO');
    } else {
        throw new HTTPError(501, 'TODO');
    }
}

function readerFromConnLength(
    conn: TCPConn, buf: DynBuf, remain: number): BodyReader
{
    return {
        length: remain,
        read: async (): Promise<Buffer> => {
            if (remain === 0) {
                return Buffer.from(''); // done
            }
            if (buf.length === 0) {
                // try to get some data if there is none
                const data = await soRead(conn);
                bufPush(buf, data);
                if (data.length === 0) {
                    // expect more data!
                    throw new Error('Unexpected EOF from HTTP body');
                }
            }
            // consume data from the buffer
            const consume = Math.min(buf.length, remain);
            remain -= consume;
            const data = Buffer.from(buf.data.subarray(0, consume));
            bufPop(buf, consume);
            return data;
        }
    };
}

//------------------------------------------------------//
//------------------- Read the Body --------------------//
async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
    // act on the request URI
    let resp: BodyReader;
    switch (req.uri.toString('latin1')) {
    case '/echo':
        // http echo server
        resp = body;
        break;
    default:
        resp = readerFromMemory(Buffer.from('hello world.\n'));
        break;
    }

    return {
        code: 200,
        headers: [Buffer.from('Server: my_first_http_server')],
        body: resp,
    };
}
function readerFromMemory(data: Buffer): BodyReader {
    let done = false;
    return {
        length: data.length,
        read: async (): Promise<Buffer> => {
            if (done) {
                return Buffer.from(''); // no more data
            } else {
                done = true;
                return data;
            }
        },
    };
}
//------------------------------------------------------//
//------------------- Send Response --------------------//
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
    if (resp.body.length < 0) {
        throw new Error('TODO: chunked encoding');
    }
    // set the "Content-Length" field
    console.assert(!fieldGet(resp.headers, 'Content-Length'));
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
    // write the header
    await soWrite(conn, encodeHTTPResp(resp));
    // write the body
    while (true) {
        const data = await resp.body.read();
        if (data.length === 0) {
            break;
        }
        await soWrite(conn, data);
    }
}

//------------------------------------------------------//
//------------------- Review the Server Loop --------------------//
async function serveClient(conn: TCPConn): Promise<void> {
    const buf: DynBuf = {data: Buffer.alloc(0), length: 0};
    while (true) {
        // try to get 1 request header from the buffer
        const msg: null|HTTPReq = cutMessage(buf);
        if (!msg) {
            // omitted ...
            continue;
        }

        // process the message and send the response
        const reqBody: BodyReader = readerFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);
        // close the connection for HTTP/1.0
        if (msg.version === '1.0') {
            return;
        }
        // make sure that the request body is consumed completely
        while ((await reqBody.read()).length > 0) { /* empty */ }
    } // loop for IO
}