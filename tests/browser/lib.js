/* 헤드리스 Chrome 헬퍼 — tests/browser/run.js 가 사용.
 *   준비: 저장소 루트에서  npm i --no-save puppeteer-core
 *         정적 서버:      python -m http.server 8123
 *   환경변수 CHROME_PATH / APP_URL 로 경로·주소를 바꿀 수 있다. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.APP_URL || 'http://localhost:8123/index.html';

async function launch(){
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--hide-scrollbars','--force-device-scale-factor=1'],
  });
}

async function newPage(browser, width=1280, height=800, dsf=2, mobile=false){
  const page = await browser.newPage();
  await page.setViewport({width, height, deviceScaleFactor: dsf, isMobile: mobile, hasTouch: mobile});
  if(mobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  await page.goto(URL, {waitUntil:'networkidle0'});
  await page.waitForFunction('window.App && window.App.State && window.App.Main');
  await sleep(600);
  return page;
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));

/* comps: [{key,type,gx,gy,rot,value,value2,label}]
   wires: [[fromKey,fromPort,toKey,toPort,dir]] */
async function build(page, comps, wires){
  await page.evaluate((comps, wires)=>{
    const S = window.App.State;
    while(S.components.length) S.removeComponent(S.components[0].id);
    const ids = {};
    comps.forEach(c=>{
      const id = S.genId();
      ids[c.key] = id;
      S.addComponent({id, type:c.type, gridX:c.gx, gridY:c.gy, rotation:c.rot||0,
                      value:c.value, value2:c.value2!==undefined?c.value2:null, label:c.label||''});
    });
    wires.forEach(w=>{
      S.addWire({id:S.genId(), fromId:ids[w[0]], fromPort:w[1], toId:ids[w[2]], toPort:w[3], direction:w[4]||'H-first'});
    });
    window.__ids = ids;
    window.App.Events.emit('state:changed');
  }, comps, wires);
  await sleep(500);
}

/* center the view on given grid rect, at scale */
async function focus(page, gx, gy, scale=1.4){
  await page.evaluate((gx,gy,scale)=>{
    const S=window.App.State, el=document.getElementById('canvas-container');
    S.viewTransform.scale=scale;
    S.viewTransform.offsetX = el.clientWidth/2 - gx*CELL_SIZE*scale;
    S.viewTransform.offsetY = el.clientHeight/2 - gy*CELL_SIZE*scale;
    window.App.Events.emit('viewport:changed');
  }, gx, gy, scale);
  await sleep(400);
}

async function select(page, key){
  await page.evaluate((key)=>{
    const id=window.__ids[key];
    window.App.State.selectedId=id;
    window.App.PropPanel.show(id);
    window.App.EditRenderer.startSelAnimation();
  }, key);
  await sleep(400);
}

async function mode(page, m){
  await page.evaluate((m)=>{
    document.querySelector('.mode-btn[data-mode="'+m+'"]').click();
  }, m);
  await sleep(800);
}

async function shot(page, name){
  const path = require('path').join(__dirname,'..','..','docs','images',name);
  await page.screenshot({path});
  console.log('  saved', name);
}

module.exports = {launch, newPage, build, focus, select, mode, shot, sleep};
