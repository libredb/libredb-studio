# Type and naming edge cases, written by docker/influxdb/seed.sh into databases home and edge on every server.
# Every timestamp is fixed on 2022-01-01 (nanoseconds), so a one-hour preview of any of these measurements is empty.
# Lines carrying an unsigned field (the u suffix) go to 2.9.1 and 3.12.0 only: InfluxDB 1.x OSS refuses the suffix.
edge,kind=int64-max v=9223372036854775807i 1641024000000000001
edge,kind=int64-min v=-9223372036854775808i 1641024000000000002
edge,kind=above-2-53 v=9007199254740993i 1641024000000000003
edge,kind=uint64-max u=18446744073709551615u 1641024000000000004
edge,kind=nanoseconds v=1i 1641024000123456789
edge,kind=nanoseconds v=2i 1641024000123456790
edge,kind=string s="say \"hi\", it's a back\\slash" 1641024000000000005
edge,kind=boolean b=true 1641024000000000006
numbers,kind=a v=1i,f=1.5 1641024000000000000
numbers,kind=b v=2i,f=-0.25 1641024001000000000
sparse,id=r1 a=1i,b=2i 1641024000000000000
sparse,id=r2 a=3i 1641024001000000000
sparse,id=r3 b=4i,c="only c" 1641024002000000000
edge\ cases\,m,room\ name=Café\ "Ünïcode"\,x,t\=k=a\=b temp\ °C=1.5,"quoted"=2i 1641024000000000000
we"ird\ name;x,room=a v=1i 1641024000000000000
