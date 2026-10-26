'use strict';
const $=id=>document.getElementById(id),canvas=$('scene'),ctx=canvas.getContext('2d');
const sim=new FlowBoids.Simulation();let selected=-1,tool='select',view='iso',paused=false,drag=null,changed=false;
const colors={wall:'#6d6b64',gather:'#b77832',portal:'#1d1d1b',attract:'#d4542b',repel:'#995447'};
const names={wall:'Wall',gather:'Gathering point',portal:'Entrance / exit',attract:'Attractor',repel:'Repulsor'};
let W=800,H=580,S=15;
function project(p){const [x,y,z]=p;return view==='plan'?[W/2+(x-10)*S,H/2+(z-10)*S]:[W/2+(x-z)*.866*S,H*.64+(x+z-20)*.5*S-y*S*.8];}
function unproject(x,y,height){if(view==='plan')return [10+(x-W/2)/S,height,10+(y-H/2)/S];const a=(x-W/2)/(.866*S),b=(y-H*.64+height*S*.8)/(.5*S)+20;return [(a+b)/2,height,(b-a)/2];}
function line(points,color,width=1,close=false,fill=null){ctx.beginPath();points.forEach((p,i)=>{const q=project(p);i?ctx.lineTo(...q):ctx.moveTo(...q);});if(close)ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
function circle(p,r,color,fill=null){const q=project(p);ctx.beginPath();ctx.arc(...q,r,0,Math.PI*2);if(fill){ctx.fillStyle=fill;ctx.fill();}ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.stroke();}
function resize(){const box=canvas.getBoundingClientRect();W=box.width;H=box.height;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=W*dpr;canvas.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);S=Math.min(W/(view==='plan'?25:39),H/(view==='plan'?25:36));}
new ResizeObserver(resize).observe(canvas);
function render(){ctx.clearRect(0,0,W,H);const peak=Math.max(...sim.density);
 line([[0,0,0],[20,0,0],[20,0,20],[0,0,20]],'#aaa69c',1,true,'#f4f2ed');
 if($('heat').checked&&peak)for(let z=0;z<20;z++)for(let x=0;x<20;x++){const n=sim.density[z*20+x]/peak;if(n>0)line([[x,0,z],[x+1,0,z],[x+1,0,z+1],[x,0,z+1]],'transparent',0,true,`rgba(212,84,43,${Math.sqrt(n)*.72})`);}
 for(let i=0;i<=20;i+=2){line([[i,0,0],[i,0,20]],'#1d1d1b16');line([[0,0,i],[20,0,i]],'#1d1d1b16');}
 if(view==='iso'){for(const [x,z] of [[0,0],[20,0],[20,20],[0,20]])line([[x,0,z],[x,20,z]],'#6d6b6466');line([[0,20,0],[20,20,0],[20,20,20],[0,20,20]],'#6d6b6466',1,true);}
 sim.modifiers.forEach((m,j)=>{const c=colors[m.type];if(m.type==='wall'){const [x,y,z]=m.p,[a,b,d]=m.size.map(v=>v/2),bottom=[[x-a,y-b,z-d],[x+a,y-b,z-d],[x+a,y-b,z+d],[x-a,y-b,z+d]],top=bottom.map(p=>[p[0],y+b,p[2]]);line(top,c,1,true,c+'55');if(view==='iso')for(let i=0;i<4;i++)line([bottom[i],bottom[(i+1)%4],top[(i+1)%4],top[i]],c,1,true,c+'30');}else{const ring=[];for(let a=0;a<=Math.PI*2+.01;a+=Math.PI/24)ring.push([m.p[0]+Math.cos(a)*m.radius,m.p[1],m.p[2]+Math.sin(a)*m.radius]);line(ring,c+'88',1,true,c+'0c');if(view==='iso')line([[m.p[0],0,m.p[2]],m.p],c+'55');}
 circle(m.p,j===selected?9:6,c,j===selected?'#fff':c);const q=project(m.p);ctx.fillStyle=c;ctx.font='11px Helvetica, Arial, sans-serif';ctx.fillText(m.type==='portal'?(m.mode==='exit'?'OUT':'IN'):names[m.type],q[0]+11,q[1]-9);
 });
 for(const b of sim.boids){if($('trails').checked&&b.trail.length>1)line(b.trail,'#1d1d1b30',1);circle(b.p,b.dwell>0?3:2,'#1d1d1b','#1d1d1b');}
 $('time').textContent=sim.time.toFixed(1);$('arrivals').textContent=sim.arrivals;$('peak').textContent=peak.toFixed(1);
}
function restart(){try{sim.reset(+$('count').value);$('status').textContent=paused?'Run reset with the same seed. Press Resume to start.':'New run started with the same random seed.';}catch(e){paused=true;$('pause').textContent='Resume';$('status').textContent=e.message;}}
function selection(){const m=sim.modifiers[selected];$('delete').disabled=!m;$('selected').textContent=m?`${names[m.type]} · X ${m.p[0].toFixed(1)}, Y ${m.p[1].toFixed(1)}, Z ${m.p[2].toFixed(1)} m`:'No modifier selected';if(m){$('height').value=m.p[1];$('radius').value=m.radius;if(m.type==='portal')$('mode').value=m.mode;if(m.type==='wall'){$('wall-height').value=m.size[1];$('axis').value=m.size[0]>m.size[2]?'x':'z';$('wall-length').value=Math.max(m.size[0],m.size[2]);}}labels();}
function labels(){for(const [id,suffix] of [['height',' m'],['radius',' m'],['speed',' m/s'],['count','']])$(id+'-out').textContent=$(id).value+suffix;}
function fit(m){for(let i=0;i<3;i++){const half=m.type==='wall'?m.size[i]/2: .3;m.p[i]=Math.max(half,Math.min(20-half,m.p[i]));}return m;}
function wallSize(){const a=Math.max(1,Math.min(18,Number($('wall-length').value)||7)),h=Math.max(1,Math.min(20,Number($('wall-height').value)||6));return $('axis').value==='x'?[a,h,.5]:[.5,h,a];}
$('tools').onclick=e=>{if(!e.target.dataset.tool)return;tool=e.target.dataset.tool;document.querySelectorAll('[data-tool]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.tool===tool));};
canvas.onpointerdown=e=>{const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;if(tool==='select'){let best=18;selected=-1;sim.modifiers.forEach((m,i)=>{const q=project(m.p),dist=Math.hypot(q[0]-x,q[1]-y);if(dist<best){best=dist;selected=i;}});selection();if(selected>=0){drag=e.pointerId;changed=false;canvas.setPointerCapture(e.pointerId);}}else{const p=unproject(x,y,+$('height').value);if(p[0]<0||p[0]>20||p[2]<0||p[2]>20){$('status').textContent='Click inside the cube at the selected height, or switch to Plan view.';return;}const m={type:tool,p,radius:+$('radius').value};if(tool==='wall')m.size=wallSize();if(tool==='portal')m.mode=$('mode').value;sim.modifiers.push(fit(m));selected=sim.modifiers.length-1;selection();restart();}};
canvas.onpointermove=e=>{if(drag!==e.pointerId)return;const m=sim.modifiers[selected],r=canvas.getBoundingClientRect();m.p=unproject(e.clientX-r.left,e.clientY-r.top,m.p[1]);fit(m);changed=true;selection();};
function endDrag(){if(drag===null)return;drag=null;if(changed)restart();}canvas.onpointerup=endDrag;canvas.onpointercancel=endDrag;
for(const id of ['height','radius','mode','wall-length','wall-height','axis'])$(id).oninput=()=>{labels();const m=sim.modifiers[selected];if(!m)return;m.p[1]=+$('height').value;m.radius=+$('radius').value;if(m.type==='portal')m.mode=$('mode').value;if(m.type==='wall')m.size=wallSize();fit(m);selection();restart();};
$('delete').onclick=()=>{if(selected<0)return;sim.modifiers.splice(selected,1);selected=-1;selection();restart();};
$('count').oninput=()=>{labels();restart();};$('speed').oninput=labels;
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'Resume':'Pause';$('status').textContent=paused?'Paused. You can still edit the layout.':'Simulation running.';};$('restart').onclick=restart;
$('example').onclick=()=>{sim.modifiers=FlowBoids.example();selected=-1;selection();restart();};$('clear').onclick=()=>{sim.modifiers=[];selected=-1;selection();restart();};
for(const id of ['iso','plan'])$(id).onclick=()=>{view=id;for(const v of ['iso','plan'])$(v).setAttribute('aria-pressed',v===id);resize();};
$('export').onclick=()=>{const data={version:1,cubeMetres:20,seed:sim.seed,settings:{count:sim.boids.length,speed:+$('speed').value,flock:+$('flock').value,wander:+$('wander').value},modifiers:sim.modifiers,elapsedSeconds:sim.time,exitArrivals:sim.arrivals,density:{units:'agent-seconds per square metre, projected through all heights',width:20,order:'z rows, x columns',values:Array.from(sim.density)}};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='flow-state-interior.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
let last=0,acc=0;function frame(t){if(!last)last=t;if(!paused&&drag===null){acc+=Math.min((t-last)/1000,.1);try{while(acc>=1/60){sim.step(1/60,{speed:+$('speed').value,flock:+$('flock').value,wander:+$('wander').value});acc-=1/60;}}catch(e){paused=true;$('pause').textContent='Resume';$('status').textContent=e.message;acc=0;}}else acc=0;last=t;render();requestAnimationFrame(frame);}resize();requestAnimationFrame(frame);
