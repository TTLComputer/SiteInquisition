"""HTTP/3 peer for interop tests, built on aioquic (a developer tool, never a dependency).

  server <cert> <key> <port-file> : serve HTTP/3; each response is JSON describing the request.
                                     /delay/<ms> waits before answering; /size/<n> answers n bytes.
  client <url> <cafile>           : GET the URL over HTTP/3 and print status and body as JSON.
"""
import asyncio, json, sys
from aioquic.asyncio import serve
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DataReceived, HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ProtocolNegotiated


class Server(QuicConnectionProtocol):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.h3 = None
        self.reqs = {}

    def quic_event_received(self, event):
        if isinstance(event, ProtocolNegotiated):
            self.h3 = H3Connection(self._quic)
        if self.h3 is None:
            return
        for e in self.h3.handle_event(event):
            if isinstance(e, HeadersReceived):
                self.reqs[e.stream_id] = {"headers": [[k.decode(), v.decode()] for k, v in e.headers], "body": 0}
                if e.stream_ended:
                    asyncio.ensure_future(self.answer(e.stream_id))
            elif isinstance(e, DataReceived) and e.stream_id in self.reqs:
                self.reqs[e.stream_id]["body"] += len(e.data)
                if e.stream_ended:
                    asyncio.ensure_future(self.answer(e.stream_id))

    async def answer(self, sid):
        req = self.reqs.pop(sid)
        path = dict(req["headers"]).get(":path", "/")
        if path.startswith("/delay/"):
            await asyncio.sleep(int(path.split("/")[2]) / 1000)
        if path.startswith("/size/"):
            body = b"z" * int(path.split("/")[2])
        else:
            body = json.dumps({"stream": sid, **req}).encode()
        self.h3.send_headers(sid, [(b":status", b"200"), (b"content-type", b"application/json"), (b"x-served-by", b"aioquic")])
        self.h3.send_data(sid, body, end_stream=True)
        self.transmit()


async def server(cert, key, port_file):
    cfg = QuicConfiguration(is_client=False, alpn_protocols=H3_ALPN, max_datagram_frame_size=65536)
    cfg.load_cert_chain(cert, key)
    srv = await serve("127.0.0.1", 0, configuration=cfg, create_protocol=Server)
    port = srv._transport.get_extra_info("sockname")[1]
    with open(port_file, "w") as f:
        f.write(str(port))
    await asyncio.Future()


class Client(QuicConnectionProtocol):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.h3 = H3Connection(self._quic)
        self.done = asyncio.get_event_loop().create_future()
        self.status = None
        self.body = b""

    def quic_event_received(self, event):
        for e in self.h3.handle_event(event):
            if isinstance(e, HeadersReceived):
                self.status = dict(e.headers).get(b":status", b"").decode()
                self.headers = [[k.decode(), v.decode()] for k, v in e.headers]
            elif isinstance(e, DataReceived):
                self.body += e.data
            if getattr(e, "stream_ended", False) and not self.done.done():
                self.done.set_result(None)


async def client(url, cafile):
    from urllib.parse import urlparse
    u = urlparse(url)
    cfg = QuicConfiguration(is_client=True, alpn_protocols=H3_ALPN, server_name=u.hostname)
    cfg.load_verify_locations(cafile)
    # aioquic's connect() opens an IPv6 socket; bind IPv4 directly so IPv6-less hosts work.
    from aioquic.quic.connection import QuicConnection
    loop = asyncio.get_running_loop()
    transport, c = await loop.create_datagram_endpoint(lambda: Client(QuicConnection(configuration=cfg)), local_addr=("127.0.0.1", 0))
    try:
        c.connect(("127.0.0.1", u.port))
        await c.wait_connected()
        sid = c._quic.get_next_available_stream_id()
        c.h3.send_headers(sid, [(b":method", b"POST"), (b":scheme", b"https"), (b":authority", u.netloc.encode()), (b":path", (u.path or "/").encode()),
                                (b"x-test", b"interop"), (b"x-test", b"interop"), (b"user-agent", b"aioquic")], end_stream=False)
        c.h3.send_data(sid, b"hello from aioquic", end_stream=True)
        c.transmit()
        await asyncio.wait_for(c.done, 10)
        print(json.dumps({"status": c.status, "headers": c.headers, "body": c.body.decode(errors="replace")}))
        c.close()
        await c.wait_closed()
    finally:
        transport.close()


if __name__ == "__main__":
    if sys.argv[1] == "server":
        asyncio.run(server(*sys.argv[2:5]))
    else:
        asyncio.run(client(*sys.argv[2:4]))
