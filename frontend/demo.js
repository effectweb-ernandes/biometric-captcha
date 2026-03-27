/**
 * demo.js
 * Logica da demo do Biometric CAPTCHA.
 * Depende de: biometric-collector.js (carregado antes deste script)
 */

var iv=[],lk=0,bp=0,keys=0,fj=[],lb2=0,tbars=[],botOn=false,human=true;

function std(a){if(a.length<2)return 0;var m=mn(a);return Math.sqrt(a.map(function(x){return(x-m)*(x-m);}).reduce(function(a,b){return a+b;},0)/a.length);}
function mn(a){return a.length?a.reduce(function(a,b){return a+b;},0)/a.length:0;}
function slp(ms){return new Promise(function(r){setTimeout(r,ms);});}

function addBar(ms,bot){
  var tl=document.getElementById('tl');
  var h=Math.max(3,Math.min(ms,700)/700*50);
  var bar=document.createElement('div');
  bar.className='tb';
  bar.style.height=h+'px';
  bar.style.background=bot?'#f87171':(ms<150?'#f87171':ms<400?'#60a5fa':'#4ade80');
  bar.style.flexShrink='0';
  tl.appendChild(bar); tbars.push(bar);
  if(tbars.length>55){var old=tbars.shift();if(old.parentNode)old.parentNode.removeChild(old);}
}

function addLog(msg,cls){
  var el=document.getElementById('log');
  var d=document.createElement('div'); d.className=cls||'li';
  var t=new Date();
  d.textContent=t.getHours()+':'+String(t.getMinutes()).padStart(2,'0')+':'+String(t.getSeconds()).padStart(2,'0')+' '+msg;
  el.appendChild(d); el.scrollTop=el.scrollHeight;
}

function score(){
  if(iv.length<4)return 0;
  var cv=mn(iv)>0?std(iv)/mn(iv):0, avg=mn(iv), s=0;
  if(cv>0.5)s+=35;else if(cv>0.3)s+=25;else if(cv>0.1)s+=12;
  if(avg>150)s+=20;else if(avg>80)s+=14;else if(avg>40)s+=6;
  if(bp>=3)s+=20;else if(bp>=1)s+=12;
  if(fj.length>=1){var jv=std(fj);if(jv>300)s+=20;else if(jv>100)s+=12;else s+=2;}
  return Math.min(s,100);
}

function ui(){
  var cv=mn(iv)>0?std(iv)/mn(iv):0, avg=mn(iv);
  document.getElementById('mcv').textContent=iv.length>1?cv.toFixed(2):'--';
  document.getElementById('mavg').textContent=iv.length>1?Math.round(avg)+'ms':'--';
  document.getElementById('mbp').textContent=bp;
  document.getElementById('mkeys').textContent=keys;
  var sc=score();
  document.getElementById('spct').textContent=sc+'%';
  var bar=document.getElementById('sbar');
  bar.style.width=sc+'%';
  bar.style.background=sc>=65?'#16a34a':sc>=35?'#d97706':'#dc2626';
  var v=document.getElementById('verd');
  if(iv.length<4){v.style.cssText='background:#f5f5f5;color:#999';v.textContent='Aguardando mais dados...';}
  else if(sc>=65){v.style.cssText='background:#f0fdf4;color:#166534';v.textContent='Humano -- padrao organico detectado';}
  else if(sc>=35){v.style.cssText='background:#fffbeb;color:#92400e';v.textContent='Suspeito -- padrao ambiguo';}
  else{v.style.cssText='background:#fef2f2;color:#991b1b';v.textContent='BOT DETECTADO -- timing uniforme demais';}
}

['fn','fe','ft','fm'].forEach(function(id,idx){
  var el=document.getElementById(id);
  el.addEventListener('focus',function(){
    var now=performance.now();
    if(lb2>0&&human){var j=now-lb2;fj.push(j);addLog('Campo '+(idx+1)+' -- jump: '+Math.round(j)+'ms','lh');}
  });
  el.addEventListener('blur',function(){if(human)lb2=performance.now();});
  el.addEventListener('keydown',function(e){
    if(!human)return;
    keys++; var now=performance.now();
    if(e.key==='Backspace'){bp++;addLog('Backspace #'+bp,'lh');}
    if(lk>0){var d=now-lk;if(d<3000){iv.push(d);addBar(d,false);}}
    lk=now; ui();
    var b=document.getElementById('badge');b.className='badge bh';b.textContent='modo humano';
    if(keys===1)addLog('Iniciou digitacao','lh');
  });
});

async function runBot(){
  if(botOn)return; botOn=true; human=false; reset(false);
  var b=document.getElementById('badge');b.className='badge bb';b.textContent='bot';
  addLog('BOT iniciado -- delay fixo 50ms/tecla','lb');
  var data=[['fn','Joao da Silva Santos'],['fe','joao@bot.com'],['ft','11999999999'],['fm','Mensagem automatica sem erros.']];
  var D=50;
  for(var i=0;i<data.length;i++){
    var el=document.getElementById(data[i][0]);
    var now=performance.now(); if(lb2>0)fj.push(now-lb2);
    await slp(D);
    for(var j=0;j<data[i][1].length;j++){
      keys++; var t=performance.now();
      if(lk>0){var d=t-lk;iv.push(d);addBar(d,true);}
      lk=t; el.value+=data[i][1][j]; ui(); await slp(D);
    }
    lb2=performance.now(); await slp(D);
  }
  addLog('BOT concluido -- CV: '+(mn(iv)>0?std(iv)/mn(iv):0).toFixed(3)+' (bot aprox 0)','lb');
  b.textContent='bot finalizado'; botOn=false;
}

function enviar(){
  var sc=score(), st=document.getElementById('st');
  st.style.display='block';
  if(iv.length<4){st.className='status warn';st.textContent='Digite mais antes de enviar!';return;}
  if(sc>=45){st.className='status ok';st.textContent='PASS ('+sc+'%) -- Comportamento humano confirmado. Formulario aceito!';}
  else if(sc>=20){st.className='status warn';st.textContent='CHALLENGE ('+sc+'%) -- Verificacao adicional necessaria.';}
  else{st.className='status err';st.textContent='BLOCK ('+sc+'%) -- BOT detectado! Formulario rejeitado.';}
  addLog('ENVIO: '+(sc>=45?'PASS':sc>=20?'CHALLENGE':'BLOCK')+' (score:'+sc+'%)','li');
}

function reset(cf){
  if(cf===undefined)cf=true;
  iv=[];lk=0;bp=0;keys=0;fj=[];lb2=0;tbars=[];botOn=false;human=true;
  document.getElementById('tl').innerHTML='';
  document.getElementById('mcv').textContent='--';
  document.getElementById('mavg').textContent='--';
  document.getElementById('mbp').textContent='0';
  document.getElementById('mkeys').textContent='0';
  document.getElementById('spct').textContent='0%';
  document.getElementById('sbar').style.width='0%';
  var v=document.getElementById('verd');v.style.cssText='background:#f5f5f5;color:#999';v.textContent='Aguardando digitacao...';
  document.getElementById('st').style.display='none';
  document.getElementById('log').innerHTML='';
  var b=document.getElementById('badge');b.className='badge bi';b.textContent='aguardando';
  if(cf){['fn','fe','ft','fm'].forEach(function(id){document.getElementById(id).value='';});}
}

addLog('Sistema pronto. Digite ou clique em Simular Bot.','li');
