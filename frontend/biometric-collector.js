/**
 * BiometricCollector.js
 * Coleta passiva de sinais comportamentais para deteccao de bots.
 * Uso: const captcha = new BiometricCollector('#form'); captcha.init();
 *      const token = await captcha.getToken();
 */
class BiometricCollector {
  constructor(formSelector, options = {}) {
    this.form = document.querySelector(formSelector);
    if (!this.form) throw new Error('Formulario nao encontrado: ' + formSelector);
    this.options = { apiEndpoint: options.apiEndpoint || '/api/captcha/analyze' };
    this._keystrokeIntervals=[]; this._keystrokeTimestamps=[];
    this._fieldTransitions=[]; this._mouseVelocities=[]; this._mouseMovements=[];
    this._clickEvents=[]; this._scrollEvents=[];
    this._backspaceCount=0; this._pasteCount=0; this._focusCount=0;
    this._lastKeyTime=null; this._lastMouseTime=null; this._lastMousePos=null;
    this._activeField=null; this._fieldFocusTime=null;
    this._sessionStart=Date.now(); this._boundHandlers={};
  }
  init() { this._attachFormListeners(); this._attachMouseListeners(); this._attachScrollListeners(); return this; }
  destroy() { Object.entries(this._boundHandlers).forEach(([k,{el,event,fn}])=>el.removeEventListener(event,fn)); }
  _attachFormListeners() {
    this.form.querySelectorAll('input,textarea,select').forEach((field,idx)=>{
      const onFocus=()=>this._onFieldFocus(field,idx);
      const onKey=(e)=>this._onKeydown(e);
      const onPaste=()=>{this._pasteCount++;};
      field.addEventListener('focus',onFocus); field.addEventListener('keydown',onKey); field.addEventListener('paste',onPaste);
      this._boundHandlers['f'+idx]={el:field,event:'focus',fn:onFocus};
    });
  }
  _onFieldFocus(field,idx) {
    this._focusCount++; const now=performance.now();
    if(this._activeField!==null&&this._fieldFocusTime!==null)
      this._fieldTransitions.push({from:this._activeField,to:idx,duration:now-this._fieldFocusTime});
    this._activeField=idx; this._fieldFocusTime=now;
  }
  _onKeydown(e) {
    const now=performance.now();
    if(e.key==='Backspace')this._backspaceCount++;
    if(this._lastKeyTime!==null){const d=now-this._lastKeyTime;if(d<5000)this._keystrokeIntervals.push(d);}
    this._keystrokeTimestamps.push(now); this._lastKeyTime=now;
  }
  _attachMouseListeners() {
    const RATE=50;
    const onMove=(e)=>{
      const now=performance.now();
      if(this._lastMousePos&&this._lastMouseTime){
        const dt=now-this._lastMouseTime;
        if(dt>=RATE){
          const dx=e.clientX-this._lastMousePos.x,dy=e.clientY-this._lastMousePos.y;
          this._mouseVelocities.push(Math.sqrt(dx*dx+dy*dy)/dt);
          this._mouseMovements.push({x:e.clientX,y:e.clientY,t:now});
          this._lastMousePos={x:e.clientX,y:e.clientY}; this._lastMouseTime=now;
        }
      } else {this._lastMousePos={x:e.clientX,y:e.clientY};this._lastMouseTime=now;}
    };
    const onClick=(e)=>this._clickEvents.push({x:e.clientX,y:e.clientY,t:performance.now(),tag:e.target.tagName});
    document.addEventListener('mousemove',onMove,{passive:true}); document.addEventListener('click',onClick,{passive:true});
    this._boundHandlers['mm']={el:document,event:'mousemove',fn:onMove};
  }
  _attachScrollListeners() {
    const fn=(e)=>this._scrollEvents.push({dy:e.deltaY,t:performance.now()});
    document.addEventListener('wheel',fn,{passive:true}); this._boundHandlers['sc']={el:document,event:'wheel',fn};
  }
  _stats(arr) {
    if(arr.length<2)return{mean:0,std:0,min:0,max:0,cv:0};
    const m=arr.reduce((a,b)=>a+b,0)/arr.length;
    const std=Math.sqrt(arr.map(x=>(x-m)**2).reduce((a,b)=>a+b,0)/arr.length);
    return{mean:Math.round(m*100)/100,std:Math.round(std*100)/100,min:Math.min(...arr),max:Math.max(...arr),cv:m>0?std/m:0};
  }
  getMetrics() {
    const ks=this._stats(this._keystrokeIntervals),mv=this._stats(this._mouseVelocities),ft=this._stats(this._fieldTransitions.map(t=>t.duration));
    return{
      session:{duration:Date.now()-this._sessionStart,keystrokeCount:this._keystrokeTimestamps.length,
        backspaceCount:this._backspaceCount,pasteCount:this._pasteCount,focusCount:this._focusCount,fieldTransitions:this._fieldTransitions.length},
      keystroke:{...ks,humanProbability:Math.min(ks.cv*2,1)},
      mouse:{...mv,sampleCount:this._mouseVelocities.length,clickCount:this._clickEvents.length},
      fieldTransitions:{...ft,events:this._fieldTransitions},scroll:{eventCount:this._scrollEvents.length}
    };
  }
  computeLocalScore() {
    const m=this.getMetrics();let s=0;
    const cv=m.keystroke.cv;if(cv>0.5)s+=35;else if(cv>0.3)s+=25;else if(cv>0.1)s+=12;
    const avg=m.keystroke.mean;if(avg>150)s+=20;else if(avg>80)s+=14;else if(avg>40)s+=6;
    if(m.session.backspaceCount>=3)s+=20;else if(m.session.backspaceCount>=1)s+=12;
    if(m.mouse.sampleCount>20){if(m.mouse.cv>0.4)s+=15;else if(m.mouse.cv>0.2)s+=8;}
    if(m.fieldTransitions.std>300)s+=10;else if(m.fieldTransitions.std>100)s+=6;
    return Math.min(s,100);
  }
  async getToken() {
    const payload={metrics:this.getMetrics(),localScore:this.computeLocalScore(),timestamp:Date.now(),
      userAgent:navigator.userAgent,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen:{w:screen.width,h:screen.height,dpr:window.devicePixelRatio},language:navigator.language};
    try{
      const res=await fetch(this.options.apiEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data=await res.json(); return data.token;
    }catch(err){console.error('[BiometricCollector]',err);return null;}
  }
}
if(typeof module!=='undefined')module.exports=BiometricCollector;
