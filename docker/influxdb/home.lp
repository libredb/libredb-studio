# The home sample, written by docker/influxdb/seed.sh into database home on every server.
# NOW-<k>H is a placeholder: seed.sh replaces it with the seed time minus k hours, in seconds,
# so the 26 points cover the last 26 hours and a one-hour preview has a row.
# co is missing on the two oldest points.
home,room=Kitchen temp=22.2,hum=36.4,co=26i NOW-0H
home,room=Living\ Room temp=22.7,hum=36.5,co=26i NOW-1H
home,room=Kitchen temp=22.5,hum=36.3,co=22i NOW-2H
home,room=Living\ Room temp=23.1,hum=36.6,co=22i NOW-3H
home,room=Kitchen temp=22.8,hum=36.2,co=14i NOW-4H
home,room=Living\ Room temp=23.3,hum=36.9,co=18i NOW-5H
home,room=Kitchen temp=22.6,hum=35.9,co=9i NOW-6H
home,room=Living\ Room temp=22.7,hum=36.0,co=9i NOW-7H
home,room=Kitchen temp=22.4,hum=36.0,co=5i NOW-8H
home,room=Living\ Room temp=22.4,hum=36.0,co=7i NOW-9H
home,room=Kitchen temp=22.3,hum=36.1,co=4i NOW-10H
home,room=Living\ Room temp=22.7,hum=36.2,co=3i NOW-11H
home,room=Kitchen temp=22.3,hum=36.1,co=1i NOW-12H
home,room=Living\ Room temp=22.8,hum=36.3,co=1i NOW-13H
home,room=Kitchen temp=22.4,hum=36.0,co=0i NOW-14H
home,room=Living\ Room temp=22.8,hum=36.5,co=1i NOW-15H
home,room=Kitchen temp=22.2,hum=35.9,co=0i NOW-16H
home,room=Living\ Room temp=22.5,hum=36.0,co=0i NOW-17H
home,room=Kitchen temp=22.2,hum=36.0,co=0i NOW-18H
home,room=Living\ Room temp=22.4,hum=36.0,co=0i NOW-19H
home,room=Kitchen temp=21.8,hum=36.0,co=0i NOW-20H
home,room=Living\ Room temp=22.7,hum=36.1,co=0i NOW-21H
home,room=Kitchen temp=21.4,hum=35.9,co=0i NOW-22H
home,room=Living\ Room temp=23.0,hum=36.2,co=0i NOW-23H
home,room=Kitchen temp=21.1,hum=35.9 NOW-24H
home,room=Living\ Room temp=21.0,hum=35.9 NOW-25H
