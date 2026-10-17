#!/usr/bin/env python3
"""Prints what a Sparkplug topic actually carries, decoded by nothing this repository ships.

WHY IT IS HERE. The fixture can PRODUCE independent bytes (publisher.py) and the evidence script
can RECORD them, but until this file the repository could not READ them without the provider's own
decoder - and the one question worth asking when a value is missing from the screen is "was it on
the wire at all". On 14 October 2026 it was: an NBIRTH carried `Temperature` 99.9 and `ShiftName`
"NIGHT-SHIFT" while both rendered empty, and that answer is what sent the search into the fold
rather than into the publisher.

It subscribes as MQTT 5, the version the provider connects with, and walks the protobuf wire with
its own varint reader. Field numbers are the Sparkplug B 3.0.0 specification's.

NOTHING DEPENDS ON THIS FILE. No test imports it and no step runs it; it is a diagnostic, and the
day it disagrees with the provider one of the two is wrong and that is the point.

  python3 docker/sparkplug/read-topic.py
  python3 docker/sparkplug/read-topic.py --topic 'spBv1.0/SekoyaPlant/NBIRTH/Line1' --port 1884
"""

import socket, struct, sys, time

def _argument(name: str, fallback: str) -> str:
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else fallback


HOST = _argument("host", "127.0.0.1")
PORT = int(_argument("port", "1884"))
TOPIC = _argument("topic", "spBv1.0/SekoyaPlant/NBIRTH/Line4")

def varint_enc(n):
    out=bytearray()
    while True:
        b=n&0x7F; n>>=7; out.append(b|(0x80 if n else 0))
        if not n: return bytes(out)

def varint_dec(b,i):
    r=s=0
    while True:
        x=b[i]; i+=1; r|=(x&0x7F)<<s; s+=7
        if not x&0x80: return r,i

DATATYPES={1:"Int8",2:"Int16",3:"Int32",4:"Int64",5:"UInt8",6:"UInt16",7:"UInt32",8:"UInt64",
      9:"Float",10:"Double",11:"Boolean",12:"String",13:"DateTime",14:"Text"}

def fields(b):
    i=0; out=[]
    while i<len(b):
        k,i=varint_dec(b,i); f,w=k>>3,k&7
        if w==0: v,i=varint_dec(b,i); out.append((f,0,v))
        elif w==1: out.append((f,1,b[i:i+8])); i+=8
        elif w==5: out.append((f,5,b[i:i+4])); i+=4
        elif w==2:
            n,i=varint_dec(b,i); out.append((f,2,b[i:i+n])); i+=n
        else: raise SystemExit(f"unknown wire type {w}")
    return out

def print_metric(raw):
    name=alias=dt=None; value="(none)"
    for f,w,v in fields(raw):
        if f==1 and w==2: name=v.decode()
        elif f==2 and w==0: alias=v
        elif f==4 and w==0: dt=v
        elif f==11 and w==0: value=f"long_value={v}"
        elif f==13 and w==1: value=f"double_value={struct.unpack('<d', v)[0]}"
        elif f==12 and w==5: value=f"float_value={struct.unpack('<f', v)[0]}"
        elif f==14 and w==0: value=f"boolean_value={bool(v)}"
        elif f==15 and w==2: value=f'string_value="{v.decode()}"'
    print(f"   metric: name={name!r} alias={alias} datatype={dt} ({DATATYPES.get(dt, '?')}) · {value}")

s=socket.create_connection((HOST,PORT),timeout=5)
cid=b"what-is-on-the-wire"
vh=b"\x00\x04MQTT\x04\x02\x00\x3c"+struct.pack(">H",len(cid))+cid
s.sendall(b"\x10"+varint_enc(len(vh))+vh); s.recv(4)
t=TOPIC.encode()
sub=struct.pack(">H",1)+struct.pack(">H",len(t))+t+b"\x00"
s.sendall(b"\x82"+varint_enc(len(sub))+sub); s.recv(5)
print(f"subscribed to {TOPIC} on {HOST}:{PORT}")

buffer=b""; deadline=time.time()+8
while time.time()<deadline:
    s.settimeout(1.0)
    try: data=s.recv(65535)
    except socket.timeout: continue
    if not data: break
    buffer+=data
    while len(buffer)>=2:
        if buffer[0]>>4 != 3: buffer=buffer[1:]; continue
        n,i=varint_dec(buffer,1)
        if len(buffer)<i+n: break
        body=buffer[i:i+n]; buffer=buffer[i+n:]
        tl=struct.unpack(">H",body[:2])[0]
        topic=body[2:2+tl].decode(); payload=body[2+tl:]
        print(f"\nPUBLISH {topic} · {len(payload)} bytes")
        for f,w,v in fields(payload):
            if f==1 and w==0: print(f"   payload.timestamp={v}")
            elif f==3 and w==0: print(f"   payload.seq={v}")
            elif f==2 and w==2: print_metric(v)
        deadline=0  # one message is enough
        break
s.close()
