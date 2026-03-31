/**
 * demo.js - Biometric CAPTCHA demo logic
 * Depends on: biometric-collector.js (loaded first)
 */
var iv=[],lk=0,lpk=0,bp=0,keys=0,fj=[],lb2=0,tbars=[],botOn=false,human=true;
var bgm={},lbk=null,fkd={},fks={},ffo={},fiv={},bts=[];
var fjSusp=[],lmd=0,ltab=0,fcnt=0,synthEvt=false;
// fj      = human transition times (lpk→mousedown or lpk→Tab), for variance scoring
// fjSusp  = programmatic focus records (no mousedown/Tab before focus)
// lmd/ltab = last mousedown / Tab keydown timestamp (0 = never set)
// lpk     = last non-Tab keydown timestamp (used for Tab-transition timing)
// fcnt    = total focus events this session (first is exempt from bot check)
// synthEvt = synthetic (non-isTrusted) mouse/keyboard event detected
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
  tl.appendChild(bar);tbars.push(bar);
  if(tbars.length>55){var old=tbars.shift();if(old.parentNode)old.parentNode.removeChild(old);}
}
function addLog(msg,cls){
  var el=document.getElementById('log');
  var d=document.createElement('div');d.className=cls||'li';
  var t=new Date();
  d.textContent=t.getHours()+':'+String(t.getMinutes()).padStart(2,'0')+':'+String(t.getSeconds()).padStart(2,'0')+' '+msg;
  el.appendChild(d);el.scrollTop=el.scrollHeight;
}
function score(){
  if(iv.length<4)return 0;
  var cv=mn(iv)>0?std(iv)/mn(iv):0,avg=mn(iv),s=0;
  // 1. Keystroke variance (25 pts)
  if(cv>0.5)s+=25;else if(cv>0.3)s+=18;else if(cv>0.1)s+=9;
  // 2. Average speed (15 pts)
  if(avg>150)s+=15;else if(avg>80)s+=10;else if(avg>40)s+=5;
  // 3. Backspaces (10 pts)
  if(bp>=3)s+=10;else if(bp>=1)s+=6;
  // 4. Field transitions variance (5 pts)
  if(fj.length>=1){var jv=std(fj);if(jv>300)s+=5;else if(jv>100)s+=3;}
  // 5. Bigrams (15 pts)
  var reps=Object.values(bgm).filter(function(a){return a.length>=3;});
  var hiBg=reps.filter(function(a){var m=mn(a);return m>0&&std(a)/m>0.2;}).length;
  var loBg=reps.filter(function(a){var m=mn(a);return m>0&&std(a)/m<0.1;}).length;
  if(hiBg>0)s+=15;else if(reps.length>0&&loBg===0)s+=8;
  // 6. Rhythm curve (10 pts)
  var t3=Math.floor(iv.length/3);
  if(t3>=2){var rm=[mn(iv.slice(0,t3)),mn(iv.slice(t3,2*t3)),mn(iv.slice(2*t3))];var rv=std(rm);if(rv>20)s+=10;else if(rv>10)s+=5;}
  // 7. Honeypot timing (10 pts)
  var delays=Object.values(fkd);
  if(delays.length>0){var hd=delays.filter(function(d){return d>=100&&d<=1500;}).length;if(hd===delays.length)s+=10;else if(hd>0)s+=5;}
  // Penalties
  if(keys>=50&&bp===0)s=Math.max(0,s-15);
  if(reps.length>0&&loBg>hiBg)s=Math.max(0,s-15);
  var fmeans=Object.values(fiv).filter(function(a){return a.length>=3;}).map(function(a){return mn(a);});
  if(fmeans.length>=2){var fmcv=mn(fmeans)>0?std(fmeans)/mn(fmeans):0;if(fmcv<0.05)s=Math.max(0,s-10);}
  if(delays.filter(function(d){return d<50;}).length>0)s=Math.max(0,s-15);
  // Penalty: programmatic focus or synthetic events = direct BOT
  if(fjSusp.length>0||synthEvt)return 0;
  // Penalty: human transition < 300ms (fast Tab or fast click after typing)
  var fastHuman=fj.filter(function(j){return j>0&&j<300;}).length;
  s=Math.max(0,s-15*fastHuman);
  // Penalty: artificially random (CV > 0.95) with suspiciously regular backspaces
  if(cv>0.95&&bts.length>=3){
    var bsi=[];for(var bi=1;bi<bts.length;bi++)bsi.push(bts[bi]-bts[bi-1]);
    var bscv=mn(bsi)>0?std(bsi)/mn(bsi):1;
    if(bscv<0.15)s=Math.max(0,s-10);
  }
  return Math.min(s,100);
}
function ui(){
  var cv=mn(iv)>0?std(iv)/mn(iv):0,avg=mn(iv);
  document.getElementById('mcv').textContent=iv.length>1?cv.toFixed(2):'--';
  document.getElementById('mavg').textContent=iv.length>1?Math.round(avg)+'ms':'--';
  document.getElementById('mbp').textContent=bp;
  document.getElementById('mkeys').textContent=keys;
  // Avg field transition time
  var tel=document.getElementById('mtrans');
  if(tel){
    if(synthEvt){
      tel.textContent='BOT (evento sintetico)';
      tel.style.color='#dc2626';
    } else if(fjSusp.length>0){
      tel.textContent='BOT (sem interacao)';
      tel.style.color='#dc2626';
    } else if(fj.length>0){
      var avgTrans=Math.round(mn(fj));
      tel.textContent=avgTrans+'ms media';
      tel.style.color=fj.filter(function(j){return j<300;}).length>0?'#d97706':'';
    } else {
      tel.textContent='--';tel.style.color='';
    }
  }
  var sc=score();
  document.getElementById('spct').textContent=sc+'%';
  var bar=document.getElementById('sbar');
  bar.style.width=sc+'%';
  bar.style.background=sc>=80?'#16a34a':sc>=60?'#d97706':'#dc2626';
  var v=document.getElementById('verd');
  if(iv.length<4){v.style.cssText='background:#f5f5f5;color:#999';v.textContent='Aguardando mais dados...';}
  else if(sc>=80){v.style.cssText='background:#f0fdf4;color:#166534';v.textContent='Humano -- padrao organico detectado';}
  else if(sc>=60){v.style.cssText='background:#fffbeb;color:#92400e';v.textContent='Suspeito -- padrao ambiguo';}
  else{v.style.cssText='background:#fef2f2;color:#991b1b';v.textContent='BOT DETECTADO -- timing uniforme demais';}
}
['fn','fe','ft','fm'].forEach(function(id,idx){
  var el=document.getElementById(id);
  // mousedown/touchstart on each field → mark that focus will be human-initiated
  // isTrusted=false means JS-dispatched synthetic event → bot
  el.addEventListener('mousedown',function(e){
    if(e.isTrusted){lmd=performance.now();}
    else{synthEvt=true;addLog('Campo '+(idx+1)+': evento sintetico detectado \u26a0 BOT','lb');ui();}
  });
  el.addEventListener('touchstart',function(e){
    if(e.isTrusted){lmd=performance.now();}
    else{synthEvt=true;addLog('Campo '+(idx+1)+': evento sintetico detectado \u26a0 BOT','lb');ui();}
  },{passive:true});
  el.addEventListener('focus',function(){
    var now=performance.now();
    ffo[idx]=now;
    fcnt++;
    var isFirst=(fcnt===1); // first focus in session exempt (page load / autofocus)
    // Determine focus origin from which event preceded it (within 500ms)
    var type=lmd>0&&(now-lmd)<500?'mouse':ltab>0&&(now-ltab)<500?'tab':'none';
    if(!isFirst){
      if(type==='none'){
        // Programmatic: element.focus() with no user interaction
        fjSusp.push(0);
        addLog('Campo '+(idx+1)+': foco programatico ⚠ BOT','lb');
        ui();
      } else {
        // Real transition time: from last keystroke to the human event that caused focus
        // Tab: use lpk (last non-Tab key) because ltab===lk when Tab is pressed
        var trans=type==='mouse'?(lk>0?lmd-lk:null):(lpk>0?ltab-lpk:null);
        var transStr=trans!==null?' ('+Math.round(trans)+'ms)':'';
        if(trans!==null&&trans>0)fj.push(trans);
        if(type==='mouse'){
          addLog('Campo '+(idx+1)+': foco via mouse'+transStr+' ✓','lh');
        } else {
          var sym=trans!==null&&trans<300?' ⚠':' ✓';
          addLog('Campo '+(idx+1)+': foco via Tab'+transStr+sym,'lh');
        }
      }
    }
    lb2=now;
  });
  el.addEventListener('blur',function(){lb2=performance.now();});
  el.addEventListener('keydown',function(e){
    if(!human)return;
    keys++;var now=performance.now();
    if(e.key==='Tab'){if(e.isTrusted)ltab=now;else{synthEvt=true;addLog('Campo '+(idx+1)+': Tab sintetico \u26a0 BOT','lb');}}
    else lpk=now;
    if(e.key==='Backspace'){bp++;bts.push(now);addLog('Backspace #'+bp,'lh');}
    var isPrintable=e.key.length===1;
    if(lk>0){
      var d=now-lk;
      if(d<3000){
        iv.push(d);addBar(d,false);
        if(!fiv[idx])fiv[idx]=[];
        fiv[idx].push(d);
        if(isPrintable&&lbk!==null){var bg2=lbk+e.key;if(!bgm[bg2])bgm[bg2]=[];bgm[bg2].push(d);}
      }
    }
    if(!fks[idx]&&ffo[idx]!==undefined){fkd[idx]=now-ffo[idx];fks[idx]=true;}
    lbk=isPrintable?e.key:null;
    lk=now;ui();
    var b=document.getElementById('badge');b.className='badge bh';b.textContent='modo humano';
    if(keys===1)addLog('Iniciou digitacao','lh');
  });
});
// ── Email validation ───────────────────────────────────────────────────────────
var DISP=['mailinator.com','tempmail.com','guerrillamail.com','yopmail.com',
          'trashmail.com','throwam.com','fakeinbox.com'];
function valEmail(v){
  var s=v?v.trim():'';
  // 1. Empty
  if(!s)return{ok:false,msg:'E-mail obrigat\u00f3rio'};
  // 2. Exactly one "@" with non-empty local and domain parts
  var parts=s.split('@');
  if(parts.length!==2||!parts[0]||!parts[1])return{ok:false,msg:'Formato inv\u00e1lido'};
  var domain=parts[1].toLowerCase();
  // 3. Domain must contain a dot not at the start or end
  var dot=domain.indexOf('.');
  if(dot<1||dot===domain.length-1)return{ok:false,msg:'Formato inv\u00e1lido'};
  // 4. Disposable domain — checked BEFORE returning ok
  //    Matches exact domain or any subdomain (e.g. mail.mailinator.com)
  for(var i=0;i<DISP.length;i++){
    if(domain===DISP[i]||domain.slice(-(DISP[i].length+1))==='.'+DISP[i]){
      return{ok:false,msg:'E-mail tempor\u00e1rio n\u00e3o permitido'};
    }
  }
  return{ok:true,msg:''};
}
function showEmailFb(ok,msg){
  var el=document.getElementById('fe');
  var fb=document.getElementById('fe-msg');
  if(!fb)return;
  if(!el.value){el.className='';fb.textContent='';fb.className='fe-msg';return;}
  el.className=ok?'valid':'invalid';
  fb.textContent=ok?'\u2713 E-mail valido':msg;
  fb.className='fe-msg '+(ok?'ok':'err');
}
document.getElementById('fe').addEventListener('blur',function(){
  var r=valEmail(this.value.trim());showEmailFb(r.ok,r.msg);
});
document.getElementById('fe').addEventListener('input',function(){
  if(!this.value){this.className='';var fb=document.getElementById('fe-msg');if(fb){fb.textContent='';fb.className='fe-msg';}}
});
async function runBot(){
  if(botOn)return;botOn=true;human=false;reset(false);
  var b=document.getElementById('badge');b.className='badge bb';b.textContent='bot';
  addLog('BOT iniciado -- foco programatico + digitacao 50ms','lb');
  var data=[['fn','Joao da Silva Santos'],['fe','joao@bot.com'],['ft','11999999999'],['fm','Mensagem automatica.']];
  var D=50;
  for(var i=0;i<data.length;i++){
    var el=document.getElementById(data[i][0]);
    el.focus(); // programmatic — no mousedown/Tab before this; focus event fires and is detected
    await slp(5);
    for(var j=0;j<data[i][1].length;j++){
      keys++;var t=performance.now();
      if(lk>0){var d=t-lk;iv.push(d);addBar(d,true);}
      lk=t;el.value+=data[i][1][j];ui();await slp(D);
    }
  }
  addLog('BOT concluido -- CV: '+(mn(iv)>0?std(iv)/mn(iv):0).toFixed(3)+' | Focos bot: '+fjSusp.length,'lb');
  b.textContent='bot finalizado';botOn=false;ui();
}
function enviar(){
  var st=document.getElementById('st');
  st.style.display='block';
  if(iv.length<4){st.className='status warn';st.textContent='Digite mais antes de enviar!';return;}
  // Email validation
  var er=valEmail(document.getElementById('fe').value.trim());
  if(!er.ok){
    st.className='status warn';st.textContent='Por favor, informe um e-mail valido antes de enviar';
    showEmailFb(false,er.msg);return;
  }
  // Hard block: synthetic events (fake mousedown/Tab dispatched by JS)
  if(synthEvt){
    st.className='status err';
    st.textContent='BOT DETECTADO -- eventos de mouse/teclado sinteticos';
    addLog('BLOQUEIO: evento sintetico (isTrusted=false) detectado','lb');
    return;
  }
  // Hard block: programmatic focus with no user interaction
  if(fjSusp.length>0){
    st.className='status err';
    st.textContent='BOT DETECTADO -- foco em campo sem interacao do usuario';
    addLog('BLOQUEIO: foco programatico detectado em '+fjSusp.length+' campo(s)','lb');
    return;
  }
  var sc=score();
  if(sc>=80){st.className='status ok';st.textContent='PASS ('+sc+'%) -- Comportamento humano confirmado!';}
  else if(sc>=60){
    st.className='status warn';
    st.textContent='SUSPEITO ('+sc+'%) -- Verificacao adicional necessaria. Envio bloqueado.';
    addLog('BLOQUEIO: score suspeito '+sc+'%','lb');
    return;
  }
  else{st.className='status err';st.textContent='BLOCK ('+sc+'%) -- BOT detectado!';}
  addLog('ENVIO: '+(sc>=80?'PASS':'BLOCK')+' score:'+sc+'%','li');
}
function reset(cf){
  if(cf===undefined)cf=true;
  iv=[];lk=0;lpk=0;bp=0;keys=0;fj=[];lb2=0;tbars=[];botOn=false;human=true;
  bgm={};lbk=null;fkd={};fks={};ffo={};fiv={};bts=[];
  fjSusp=[];lmd=0;ltab=0;fcnt=0;synthEvt=false;
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
  if(cf){
    ['fn','fe','ft','fm'].forEach(function(id){document.getElementById(id).value='';});
    document.getElementById('fe').className='';
    var fb=document.getElementById('fe-msg');if(fb){fb.textContent='';fb.className='fe-msg';}
  }
}
addLog('Sistema pronto. Digite ou clique em Simular Bot.','li');
