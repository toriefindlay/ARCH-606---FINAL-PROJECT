/* Pure simulation; x/z horizontal, y vertical, all coordinates in metres. */
(function(root) {
'use strict';
const SIZE=20, R=.18, DT=1/60;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const length=v=>Math.hypot(...v);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const unit=v=>{const n=length(v);return n?v.map(x=>x/n):[1,0,0];};
function random(seed=42){let n=seed>>>0;return ()=>{n=(1664525*n+1013904223)>>>0;return n/4294967296;};}
function wallBounds(m){return [m.p.map((x,i)=>x-m.size[i]/2-R),m.p.map((x,i)=>x+m.size[i]/2+R)];}
function inside(p,m){const [lo,hi]=wallBounds(m);return p.every((x,i)=>x>=lo[i]&&x<=hi[i]);}
// Segment vs expanded box: includes the agent radius and prevents tunnelling.
function hits(a,b,m){const [lo,hi]=wallBounds(m);let near=0,far=1;
 for(let i=0;i<3;i++){const d=b[i]-a[i];if(Math.abs(d)<1e-10){if(a[i]<lo[i]||a[i]>hi[i])return false;}else{let t=(lo[i]-a[i])/d,u=(hi[i]-a[i])/d;if(t>u)[t,u]=[u,t];near=Math.max(near,t);far=Math.min(far,u);if(near>far)return false;}}return true;}
function example(){return [
 {type:'portal',mode:'entrance',p:[1,1,10],radius:1.4},
 {type:'portal',mode:'exit',p:[19,1,10],radius:1.4},
 {type:'wall',p:[10,3,6],size:[.5,6,8],radius:3},
 {type:'gather',p:[6,1,14],radius:2.5},
 {type:'attract',p:[14,3,14],radius:5},
 {type:'repel',p:[13,1,5],radius:3}];}
class Simulation {
 constructor({count=100,seed=42,modifiers=example()}={}){this.seed=seed;this.modifiers=modifiers;this.reset(count);}
 reset(count=this.boids.length){this.rng=random(this.seed);this.time=0;this.arrivals=0;this.density=new Float64Array(400);this.boids=[];for(let i=0;i<count;i++)this.boids.push(this.spawn());}
 free(p){return p.every(v=>v>=R&&v<=SIZE-R)&&!this.modifiers.some(m=>m.type==='wall'&&inside(p,m));}
 spawn(){const entrances=this.modifiers.filter(m=>m.type==='portal'&&m.mode==='entrance');let p;
 for(let tries=0;tries<200;tries++){const e=entrances[Math.floor(this.rng()*entrances.length)];p=e&&tries<100?e.p.map(v=>clamp(v+(this.rng()-.5)*e.radius,R,SIZE-R)):[R+this.rng()*(SIZE-2*R),R+this.rng()*(SIZE-2*R),R+this.rng()*(SIZE-2*R)];if(this.free(p))break;}
 if(!this.free(p))throw new Error('No free space for agents. Remove or shrink walls.');
 return {p,v:unit([this.rng()-.5,(this.rng()-.5)*.3,this.rng()-.5]).map(v=>v*2),trail:[],dwell:0,cooldown:0};}
 step(dt=DT,{speed=2.4,flock=1,wander=1}={}){dt=clamp(dt,0,1/30);const old=this.boids.map(b=>({p:[...b.p],v:[...b.v]}));const walls=this.modifiers.filter(m=>m.type==='wall');const exits=this.modifiers.filter(m=>m.type==='portal'&&m.mode==='exit');this.time+=dt;
 this.boids.forEach((b,k)=>{
 if(!this.free(b.p)){Object.assign(b,this.spawn());}
 b.cooldown=Math.max(0,b.cooldown-dt);
 if(b.dwell>0){b.dwell-=dt;}else{
 let force=[(this.rng()-.5)*5*wander,(this.rng()-.5)*2*wander,(this.rng()-.5)*5*wander],align=[0,0,0],center=[0,0,0],n=0;
 old.forEach((o,j)=>{if(j===k)return;const d=sub(b.p,o.p),r=length(d);if(r<3.2){n++;for(let i=0;i<3;i++){align[i]+=o.v[i];center[i]+=o.p[i];if(r<1.1)force[i]+=d[i]/Math.max(r*r,.01)*5;}}});
 if(n)for(let i=0;i<3;i++)force[i]+=flock*((align[i]/n-b.v[i])*.6+(center[i]/n-b.p[i])*.25);
 for(const m of this.modifiers){const delta=sub(m.p,b.p),dist=length(delta);if(m.type==='attract'||m.type==='gather'||m.type==='repel'){if(dist<m.radius){const sign=m.type==='repel'?-1:1;const dir=dist<.001?unit([this.rng()-.5,this.rng()-.5,this.rng()-.5]):unit(delta);for(let i=0;i<3;i++)force[i]+=dir[i]*sign*(1-dist/m.radius)*7;if(m.type==='gather'&&dist<.6&&b.cooldown===0){b.dwell=2.5;b.cooldown=8;}}}}
 if(exits.length){const target=exits.reduce((a,c)=>length(sub(a.p,b.p))<length(sub(c.p,b.p))?a:c);const dir=unit(sub(target.p,b.p));for(let i=0;i<3;i++)force[i]+=dir[i]*1.6;}
 for(const w of walls){const [lo,hi]=wallBounds(w),closest=b.p.map((x,i)=>clamp(x,lo[i],hi[i])),d=sub(b.p,closest),r=length(d);if(r<1.5&&r>0)for(let i=0;i<3;i++)force[i]+=d[i]/r*(1-r/1.5)*12;}
 for(let i=0;i<3;i++){if(b.p[i]<1)force[i]+=(1-b.p[i])*8;if(b.p[i]>19)force[i]-=(b.p[i]-19)*8;b.v[i]+=force[i]*dt;}
 const s=length(b.v);if(s>speed)b.v=b.v.map(v=>v*speed/s);
 const next=b.p.map((v,i)=>clamp(v+b.v[i]*dt,R,SIZE-R));
 // Resolve axes separately: agents slide along walls instead of crossing them.
 for(let i=0;i<3;i++){const candidate=[...b.p];candidate[i]=next[i];if(walls.some(w=>hits(b.p,candidate,w)))b.v[i]*=-.35;else b.p=candidate;if(next[i]===R||next[i]===SIZE-R)b.v[i]*=-1;}
 }
 if(exits.some(e=>length(sub(e.p,b.p))<e.radius)){this.arrivals++;Object.assign(b,this.spawn());}
 this.density[Math.min(19,Math.floor(b.p[2]))*20+Math.min(19,Math.floor(b.p[0]))]+=dt;
 if(!b.trail.length||length(sub(b.p,b.trail[b.trail.length-1]))>.15){b.trail.push([...b.p]);if(b.trail.length>90)b.trail.shift();}
 });}
}
const api={Simulation,example,inside,hits,random,SIZE,R};if(typeof module!=='undefined')module.exports=api;else root.FlowBoids=api;
})(typeof globalThis!=='undefined'?globalThis:this);
