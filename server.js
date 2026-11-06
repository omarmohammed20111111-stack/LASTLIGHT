/* LASTLIGHT: dependency-light authoritative HTTP + WebSocket match server. */
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer,WebSocket}=require('ws');
// Extract the exact same engine from the delivered standalone HTML: no core.js needed.
const html=fs.readFileSync(path.join(__dirname,'LASTLIGHT.html'),'utf8');
const src=html.match(/<script id="simulation">([\s\S]*?)<\/script>/)[1];
const engine={exports:{}};new Function('module',src)(engine);const {Game,height}=engine.exports;
const PORT=Number(process.env.PORT)||8080,rooms=new Map(),clients=new Map();
const server=http.createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:rooms.size}));}if(req.url==='/'||req.url.startsWith('/?')||req.url==='/LASTLIGHT.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(html);}else{res.writeHead(404);res.end('Not found');}});
const wss=new WebSocketServer({server,maxPayload:4096});
function send(c,v){if(c.ws.readyState===WebSocket.OPEN&&c.ws.bufferedAmount<400000)c.ws.send(JSON.stringify(v));}
function fan(room,v){for(const id of room.members){let c=clients.get(id);if(c)send(c,v);}}
function lobby(room){fan(room,{type:'lobby',code:room.code,host:room.host,mode:room.mode,quick:room.quick,members:room.members.map(id=>{let c=clients.get(id);return{id,name:c.name,team:c.team};})});}
function leave(c){let room=rooms.get(c.room);if(!room)return;room.members=room.members.filter(id=>id!==c.id);if(room.game){let p=room.game.players.find(p=>p.id===c.id);if(p)room.game.hurt(p,10000,null);}if(!room.members.length)rooms.delete(room.code);else{if(room.host===c.id)room.host=room.members[0];if(!room.game)lobby(room);}c.room=null;}
function start(room){if(room.members.length<2)return false;const teamSet=new Set(room.members.map(id=>clients.get(id).team));if(teamSet.size<2){fan(room,{type:'error',message:'Choose at least two different teams before starting.'});return false;}room.game=new Game({mode:room.mode});let teamIndex=new Map();for(const id of room.members){let c=clients.get(id),p=room.game.add(id,c.name,c.team);if(!teamIndex.has(c.team))teamIndex.set(c.team,teamIndex.size);let a=teamIndex.get(c.team)*2.39996;p.x=Math.sin(a)*110+(room.members.indexOf(id)%2)*3;p.z=Math.cos(a)*110;let sx=p.x,sz=p.z;for(let k=0;room.game.blocked(p.x,p.z,.7)&&k<150;k++){let angle=k*2.39996,r=1+k*.15;p.x=sx+Math.cos(angle)*r;p.z=sz+Math.sin(angle)*r;}p.y=height(p.x,p.z);}const snapshot=room.game.snapshot();for(const id of room.members){let c=clients.get(id);send(c,{type:'start',id:c.id,state:snapshot});}room.last=Date.now();return true;}
wss.on('connection',ws=>{if(clients.size>=160){ws.close(1013,'Server capacity');return;}const id=crypto.randomBytes(5).toString('hex'),c={id,ws,name:'Ranger',room:null,team:0,count:0,window:Date.now(),alive:true};clients.set(id,c);send(c,{type:'welcome',id});ws.on('pong',()=>c.alive=true);
ws.on('message',raw=>{try{if(Date.now()-c.window>1000){c.count=0;c.window=Date.now();}if(++c.count>100)return;let m=JSON.parse(raw.toString());
if(m.type==='rooms'){send(c,{type:'rooms',rooms:[...rooms.values()].filter(r=>!r.game).map(r=>({code:r.code,mode:r.mode,count:r.members.length,quick:r.quick}))});return;}
if(m.type==='create'||m.type==='join'||m.type==='quick'){leave(c);c.name=String(m.name||'Ranger').replace(/[<>\u0000-\u001f]/g,'').slice(0,18);let mode=['solo','duo','squad'].includes(m.mode)?m.mode:'solo',room;
if(m.type==='join'){room=rooms.get(String(m.code||'').toUpperCase());if(!room)return send(c,{type:'error',message:'Room not found. Check the six-character code.'});}
else if(m.type==='quick')room=[...rooms.values()].find(r=>r.quick&&!r.game&&r.mode===mode&&r.members.length<12);
if(!room){let code;do{code=crypto.randomBytes(3).toString('hex').toUpperCase();}while(rooms.has(code));room={code,mode,members:[],host:id,game:null,quick:m.type==='quick',created:Date.now()};rooms.set(code,room);}
if(room.game||room.members.length>=12)return send(c,{type:'error',message:'That match has started or the room is full.'});let team=room.mode==='solo'?Date.now()+room.members.length:(Number.isInteger(m.team)&&m.team>=0&&m.team<8?m.team:room.members.length%2),cap=room.mode==='duo'?2:room.mode==='squad'?4:1;if(room.members.filter(id=>clients.get(id).team===team).length>=cap)return send(c,{type:'error',message:'That team is full. Choose another team.'});c.room=room.code;c.team=team;room.members.push(id);lobby(room);return;}
let room=rooms.get(c.room);if(m.type==='leave'){leave(c);return;}if(!room)return;
if(m.type==='start'&&room.host===c.id&&!room.game){if(!start(room))send(c,{type:'error',message:'At least two human players on opposing teams are required.'});}
if(m.type==='input'&&room.game){let p=room.game.players.find(p=>p.id===c.id);if(!p?.alive)return;let i=m.input||{},prior=p.input||{};p.input={forward:Math.max(-1,Math.min(1,Number(i.forward)||0)),right:Math.max(-1,Math.min(1,Number(i.right)||0)),yaw:Number.isFinite(i.yaw)?i.yaw:0,pitch:Number.isFinite(i.pitch)?i.pitch:0,aim:!!i.aim,fire:!!i.fire,sprint:!!i.sprint};for(let k of['jump','reload','heal','interact','grenade'])p.input[k]=!!i[k]||!!prior[k];if(Number.isInteger(i.slot)&&i.slot>=0&&i.slot<3)p.input.slot=i.slot;else p.input.slot=prior.slot;}
}catch(e){send(c,{type:'error',message:'Invalid request.'});}});ws.on('close',()=>{leave(c);clients.delete(id);});ws.on('error',()=>{});});
let ticks=0;const loop=setInterval(()=>{let now=Date.now();for(const room of rooms.values()){if(!room.game){if(room.quick&&room.members.length>=2){room.countdown=room.countdown||now+8000;if(now>=room.countdown)start(room);}else room.countdown=0;continue;}let dt=Math.min(.075,(now-room.last)/1000);room.last=now;room.game.step(dt);if(ticks%2===0)fan(room,{type:'state',state:room.game.snapshot()});}ticks++;},1000/30);
const heartbeat=setInterval(()=>{for(let c of clients.values()){if(!c.alive)c.ws.terminate();else{c.alive=false;c.ws.ping();}}},15000);
server.listen(PORT,'0.0.0.0',()=>console.log(`LASTLIGHT ready: http://localhost:${PORT} | LAN: http://YOUR_LAN_IP:${PORT}`));
process.on('SIGINT',()=>{clearInterval(loop);clearInterval(heartbeat);wss.close();server.close(()=>process.exit(0));});
