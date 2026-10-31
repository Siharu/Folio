/* Hekomi-chan — handcrafted pixel companion.
   64×80 logical canvas. All drawing is aligned to an integer pixel grid. */
(() => {
  'use strict';
  const W=64,H=80;
  const P={
    ink:'#171522',hair0:'#211b30',hair1:'#30253f',hair2:'#49365d',hair3:'#654b7d',hair4:'#8b6a9e',
    skin0:'#ce8e88',skin1:'#e9b3a4',skin2:'#f7cbbb',skin3:'#ffe0cf',blush:'#e99b9e',
    eye0:'#2a2039',eye1:'#5a3c7c',eye2:'#9871cc',eye3:'#c8a8f0',white:'#fff0e8',
    shirt0:'#40364f',shirt1:'#65577f',shirt2:'#8875a9',shirt3:'#ad9acb',
    mint0:'#4d9f91',mint1:'#8be1cf',pant0:'#1d2232',pant1:'#2c3145',pant2:'#41465c',
    shoe0:'#171925',shoe1:'#77718d',accent:'#c5b5ff'
  };
  const BACK_HAIR=[
    [15,7,34,7,'ink'],[12,11,40,12,'ink'],[10,20,44,22,'ink'],
    [10,37,9,17,'ink'],[11,50,9,11,'ink'],[15,57,7,8,'ink'],
    [43,38,10,18,'ink'],[45,51,8,12,'ink'],[43,60,8,6,'ink'],[17,61,7,5,'ink'],[40,64,8,4,'ink'],
    [15,10,34,7,'hair0'],[13,15,38,12,'hair0'],[12,27,7,26,'hair0'],
    [13,49,7,11,'hair0'],[17,57,5,7,'hair0'],[46,27,6,27,'hair0'],
    [46,50,6,12,'hair0'],[43,58,7,7,'hair0'],[20,61,5,4,'hair0'],
    [17,14,4,16,'hair1'],[13,29,4,17,'hair1'],[15,47,4,12,'hair1'],
    [45,29,4,17,'hair1'],[47,45,3,12,'hair1'],[43,58,4,6,'hair1'],
    [20,9,8,3,'hair2'],[30,8,8,3,'hair2'],[39,11,7,3,'hair2'],
    [14,22,3,7,'hair2'],[47,23,3,8,'hair2'],[17,17,3,8,'hair3'],
    [19,12,7,2,'hair3'],[33,10,6,2,'hair3'],[42,15,4,3,'hair3'],
    [14,42,2,6,'hair3'],[48,40,2,7,'hair3'],[17,54,2,5,'hair2'],[46,54,2,5,'hair2']
  ];
  const LEGS=[
    [20,61,25,15,'ink'],[21,62,10,14,'pant0'],[34,62,10,14,'pant0'],
    [23,63,7,10,'pant1'],[35,63,7,10,'pant1'],[30,64,4,12,'ink'],
    [21,70,8,3,'pant2'],[36,69,7,3,'pant2'],[22,74,10,3,'shoe0'],
    [34,74,11,3,'shoe0'],[19,76,13,3,'ink'],[33,76,13,3,'ink'],
    [21,74,9,2,'shoe1'],[35,74,8,2,'shoe1'],[24,67,2,5,'pant2'],[39,65,2,5,'pant2'],
    [28,63,2,3,'pant1'],[33,63,2,3,'pant1']
  ];
  const TORSO=[
    [27,39,10,9,'skin0'],[28,39,8,6,'skin2'],[29,42,6,4,'skin1'],
    [17,46,30,19,'ink'],[15,48,34,15,'ink'],[17,47,30,17,'shirt0'],
    [15,49,6,10,'shirt0'],[43,49,6,10,'shirt0'],[18,48,28,13,'shirt1'],
    [17,53,30,9,'shirt1'],[20,48,24,3,'shirt2'],[17,50,4,7,'shirt2'],
    [41,50,4,7,'shirt2'],[22,52,3,7,'shirt2'],[38,52,3,7,'shirt2'],
    [21,58,23,3,'shirt0'],[19,62,26,3,'ink'],[25,47,4,3,'shirt3'],
    [35,47,4,3,'shirt3'],[29,48,6,3,'mint0'],[30,49,4,2,'mint1'],
    [34,53,2,2,'accent'],[36,55,2,2,'accent'],[34,57,2,2,'accent'],
    [31,55,2,2,'accent'],[32,53,2,2,'accent'],[19,59,5,2,'shirt2'],[39,59,4,2,'shirt2']
  ];
  const FACE=[
    [17,17,31,26,'ink'],[19,18,27,25,'skin1'],[22,17,21,27,'skin2'],
    [19,21,3,17,'skin0'],[43,21,3,17,'skin0'],[21,19,22,3,'skin3'],
    [24,22,16,2,'skin3'],[22,39,21,3,'skin1'],[25,42,14,2,'skin0'],
    [16,27,4,6,'skin0'],[45,27,4,6,'skin0'],[18,29,2,3,'skin2'],
    [45,29,2,3,'skin2'],[21,36,3,2,'blush'],[41,36,3,2,'blush']
  ];
  const FRINGE=[
    [13,9,37,9,'ink'],[11,13,41,8,'ink'],[13,20,36,7,'ink'],
    [15,12,34,6,'hair0'],[13,17,38,6,'hair0'],[15,22,34,4,'hair0'],
    [17,9,9,5,'hair1'],[28,8,9,4,'hair1'],[39,10,8,4,'hair1'],
    [13,15,5,9,'hair1'],[46,15,5,10,'hair1'],[19,16,6,7,'hair2'],
    [30,13,6,7,'hair2'],[40,15,6,6,'hair2'],[17,21,5,8,'hair0'],
    [23,19,5,8,'hair1'],[29,18,6,8,'hair0'],[36,19,5,7,'hair1'],
    [42,21,5,7,'hair0'],[15,28,4,16,'hair0'],[13,37,4,15,'hair1'],
    [16,47,4,8,'hair0'],[44,28,4,16,'hair0'],[47,36,4,16,'hair1'],
    [44,47,4,10,'hair0'],[18,13,5,2,'hair3'],[32,11,5,2,'hair3'],
    [43,13,4,2,'hair3'],[15,24,2,5,'hair3'],[47,25,2,5,'hair3'],
    [18,34,2,7,'hair2'],[45,35,2,8,'hair2']
  ];
  function blocks(ctx,list,dy=0){
    for(const [x,y,w,h,color] of list){ctx.fillStyle=P[color];ctx.fillRect(x,y+dy,w,h);}
  }
  function drawLeftArm(ctx,dy){
    blocks(ctx,[
      [14,48,7,11,'ink'],[15,49,5,8,'shirt0'],[16,50,4,5,'shirt2'],
      [14,57,5,8,'skin0'],[13,60,6,5,'skin1'],[14,64,5,2,'skin2'],[16,62,3,2,'skin2'],[14,58,2,3,'skin1']
    ],dy);
  }
  function drawWaveArm(ctx,frame,dy){
    const poses=[
      {e:0,w:0,h:0},{e:-1,w:-1,h:-2},{e:0,w:-2,h:-1},{e:1,w:-1,h:1}
    ];
    const pose=poses[frame%poses.length],e=pose.e,w=pose.w,h=pose.h;
    blocks(ctx,[
      [41,47,9,12,'ink'],[43,48,6,9,'shirt0'],[43,49,5,6,'shirt2'],
      [47+e,47,5,8,'skin0'],[48+e,46,4,8,'skin1'],
      [49+w,39,5,11,'skin0'],[50+w,37,4,10,'skin2'],
      [49+h,31,9,9,'skin1'],[50+h,30,7,8,'skin2'],[48+h,32,3,4,'skin0'],
      [49+h,25,3,8,'skin2'],[53+h,22,3,11,'skin3'],[57+h,24,3,9,'skin2'],
      [60+h,28,2,6,'skin0'],[51+h,25,1,5,'skin3'],[55+h,22,1,7,'white'],
      [52+h,35,4,2,'skin3'],[50+w,44,2,3,'skin3']
    ],dy);
  }
  function drawEyes(ctx,expression,blink){
    if(blink){
      blocks(ctx,[[22,31,8,2,'eye0'],[23,32,6,1,'eye2'],[36,31,8,2,'eye0'],[37,32,6,1,'eye2']]);
      return;
    }
    if(expression==='happy'){
      blocks(ctx,[[22,31,2,2,'eye0'],[24,33,5,2,'eye0'],[29,31,2,2,'eye0'],
        [36,31,2,2,'eye0'],[38,33,5,2,'eye0'],[43,31,2,2,'eye0'],[25,34,3,1,'eye2'],[39,34,3,1,'eye2']]);
      return;
    }
    if(expression==='sleepy'){
      blocks(ctx,[[22,31,8,2,'eye0'],[23,32,6,2,'eye1'],[36,31,8,2,'eye0'],[37,32,6,2,'eye1']]);
      return;
    }
    const surprised=expression==='surprised';
    blocks(ctx,[
      [21,28,10,2,'eye0'],[35,28,10,2,'eye0'],
      [22,30,8,surprised?7:5,'white'],[36,30,8,surprised?7:5,'white'],
      [24,30,5,surprised?7:5,'eye1'],[38,30,5,surprised?7:5,'eye1'],
      [25,31,4,surprised?6:4,'eye2'],[39,31,4,surprised?6:4,'eye2'],
      [26,31,2,3,'eye3'],[40,31,2,3,'eye3'],[25,31,1,1,'white'],[39,31,1,1,'white'],
      [22,29,3,1,'hair0'],[42,29,3,1,'hair0']
    ]);
  }
  function drawFaceDetails(ctx,expression){
    blocks(ctx,[[18,30,2,4,'skin1'],[45,30,2,4,'skin1'],[21,37,4,2,'blush'],[41,37,4,2,'blush'],[31,36,2,3,'skin0'],[32,37,2,2,'skin2']]);
    if(expression==='surprised')blocks(ctx,[[31,40,4,4,'skin0'],[32,40,2,2,'ink']]);
    else if(expression==='sleepy')blocks(ctx,[[30,40,5,1,'eye0'],[34,41,2,1,'skin0']]);
    else if(expression==='happy')blocks(ctx,[[29,39,2,2,'eye0'],[31,41,4,2,'eye0'],[35,39,2,2,'eye0']]);
    else blocks(ctx,[[30,40,5,1,'eye0'],[34,41,2,1,'eye0']]);
  }
  function drawSprite(ctx,frame){
    ctx.clearRect(0,0,W,H);
    const dy=frame.bob;
    blocks(ctx,BACK_HAIR,dy);
    blocks(ctx,LEGS,dy);
    blocks(ctx,TORSO,dy);
    drawLeftArm(ctx,dy);
    drawWaveArm(ctx,frame.wave,dy);
    blocks(ctx,FACE,dy);
    blocks(ctx,FRINGE,dy);
    blocks(ctx,[
      [13,45,5,12,'hair0'],[14,54,4,7,'hair1'],[45,46,5,12,'hair0'],
      [46,54,4,8,'hair1'],[17,58,3,5,'hair0'],[44,60,3,5,'hair0']
    ],dy);
    drawEyes(ctx,frame.expression,frame.blink);
    drawFaceDetails(ctx,frame.expression);
    blocks(ctx,[
      [43,22,3,1,'mint1'],[44,21,1,3,'mint1'],[46,22,2,1,'accent'],
      [17,18,2,1,'hair4'],[48,35,1,3,'hair3'],[13,44,1,4,'hair3'],
      [26,49,2,1,'shirt3'],[37,56,2,1,'shirt3'],[23,66,2,1,'pant2'],[37,66,2,1,'pant2']
    ],dy);
  }
  class HekomiChan{
    constructor(canvas,message){
      this.canvas=canvas;this.ctx=canvas.getContext('2d',{alpha:true});this.message=message;
      this.mood='idle';this.lockedMood=null;this.lastPaint=0;this.reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.canvas.width=W;this.canvas.height=H;this.ctx.imageSmoothingEnabled=false;this.canvas.style.imageRendering='pixelated';
      this.canvas.setAttribute('role','button');this.canvas.setAttribute('tabindex','0');
      this.canvas.setAttribute('aria-label','Hekomi-chan. Activate to change her expression.');this.canvas.title='Say hi to Hekomi-chan';
      this.canvas.addEventListener('pointerenter',()=>{
        if(!this.lockedMood){this.mood='wave';this.say('Oh! Hi there!');this.paint(performance.now(),true);}
      });
      this.canvas.addEventListener('pointerleave',()=>{
        if(!this.lockedMood){this.mood='idle';this.say('Oh, you’re here!');this.paint(performance.now(),true);}
      });
      this.canvas.addEventListener('click',()=>this.nextMood());
      this.canvas.addEventListener('keydown',event=>{
        if(event.key==='Enter'||event.key===' '){event.preventDefault();this.nextMood();}
      });
      document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.paint(performance.now(),true);});
      this.paint(performance.now(),true);
      if(!this.reduced)requestAnimationFrame(time=>this.tick(time));
    }
    say(text){if(this.message)this.message.textContent=text;}
    nextMood(){
      const moods=['happy','surprised','sleepy','wave'];
      const index=moods.indexOf(this.lockedMood||'idle');
      this.lockedMood=moods[(index+1)%moods.length];this.mood=this.lockedMood;
      const messages={happy:'Hehe. You found me!',surprised:'Eh?! A new visitor!',sleepy:'Five more minutes…',wave:'Come on in, friend!'};
      this.say(messages[this.mood]);this.paint(performance.now(),true);
    }
    tick(time){
      if(document.hidden){requestAnimationFrame(next=>this.tick(next));return;}
      if(time-this.lastPaint>115)this.paint(time,false);
      requestAnimationFrame(next=>this.tick(next));
    }
    paint(time,force){
      if(!force&&time-this.lastPaint<110)return;
      this.lastPaint=time;
      const cycle=Math.floor(time/150);
      const idleWave=this.mood==='idle'?(Math.floor(time/1350)%4===0?cycle%4:0):cycle%4;
      const blink=this.mood==='idle'&&(time%4700<115||time%4700>4320);
      const expression=this.mood==='happy'?'happy':this.mood==='sleepy'?'sleepy':this.mood==='surprised'?'surprised':'normal';
      const bob=this.mood==='sleepy'?1:(Math.floor(time/460)%2);
      drawSprite(this.ctx,{expression,blink:blink||(this.mood==='sleepy'&&cycle%20<2),wave:idleWave,bob});
    }
  }
  function boot(){
    const canvas=document.getElementById('hekomiChanCanvas');
    if(!canvas||canvas.dataset.hekomiReady)return;
    canvas.dataset.hekomiReady='true';
    const companion=new HekomiChan(canvas,document.getElementById('hekomiChanMessage'));
    window.hekomiChan=companion;window.HekomiChan=HekomiChan;
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();