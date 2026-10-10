import test from 'node:test';
import assert from 'node:assert/strict';
import { TRADING_CATEGORIES, isExcludedListing, isVisibleListing } from '../../assets/categories.mjs';
import { classifyListings, decisionEndpoint, extractProductName, productKeyForName } from '../lib/products.mjs';
import { createServer } from 'node:http';

test('fixed category list excludes bicycles and legacy ebike feed entries', () => {
  assert.equal(TRADING_CATEGORIES.length, 5);
  for (const row of [{queryId:'ebike'}, {title:'Bosch E-Bike'}, {product:{category:'Fahrräder'}}, {title:'Pedelec'}]) {
    assert.equal(isExcludedListing(row), true); assert.equal(isVisibleListing(row), false);
  }
  assert.equal(isVisibleListing({title:'iPhone 13'}), true);
  assert.equal(isVisibleListing({product:{decision:{accepted:false}}}), false);
});
test('conservative model extraction and endpoint', () => {
  assert.equal(extractProductName({title:'PS5 Pro 2Tb mit Controller'}, 'console'), 'Sony PlayStation 5 Pro 2 TB');
  assert.equal(extractProductName({title:'iPhone 13 128GB weiß'}, 'iphone'), 'Apple iPhone 13 128 GB');
  assert.equal(extractProductName({title:'tolle Kamera'}, 'kamera'), null);
  assert.equal(decisionEndpoint('http://localhost:11434/v1/'), 'http://localhost:11434/v1/systemone');
  assert.equal(productKeyForName('Apple iPhone 13 128GB'), productKeyForName('Apple iPhone 13 128 GB'));
});
test('Tev1 yes/no, ambiguity, rejection, invalid responses, catalog reuse and no Qwen fallback', async () => {
  const requests = [];
  const server = createServer(async (req,res) => {
    let text=''; for await (const part of req) text+=part;
    const body=JSON.parse(text); requests.push({url:req.url,body});
    const answers=Object.fromEntries(TRADING_CATEGORIES.map(c=>[c.id,{noul:0.01}]));
    if (body.state.title.includes('iPhone')) answers.iphone.noul=0.95;
    if (body.state.title.includes('ambiguous')) answers.console.noul=0.9;
    if (body.state.title.includes('invalid')) answers.iphone.noul='yes';
    res.setHeader('content-type','application/json');res.end(JSON.stringify({answers}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const config={ai:{model:'tev1:0.8b',enabled:true,apiKey:'ollama',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:5000,maxDescriptionChars:700}};
    const titles=['iPhone 13 128GB Preis 200 €','iPhone 13 ambiguous','PS5 Controller','iPhone invalid','E-Bike'];
    const items=titles.map((title,index)=>({listing:{id:String(index),title,price:200,queryLabel:'Do not trust this keyword',description:'Price 200 €'}}));
    const catalog={products:{'existing-key':{name:'Apple iPhone 13 128 GB',referencePrice:300}}};
    const output=await classifyListings({items,config,catalog});
    assert.equal(output.results.get('0').key,'existing-key');
    assert.equal(output.results.get('0').category,'iPhone');
    assert.equal(catalog.products['existing-key'].referencePrice,300);
    assert.equal(output.results.get('1').decision.status,'ambiguous');
    assert.equal(output.results.get('2').decision.status,'rejected');
    assert.equal(output.results.get('3').decision.status,'pending');
    assert.equal(output.results.get('4').decision.status,'excluded');
    assert.equal(requests.length,4);
    assert.equal(requests[0].url,'/v1/systemone');
    assert.equal(Object.keys(requests[0].body.questions).length,5);
    assert.ok(!JSON.stringify(requests[0].body).includes('200'));
    assert.ok(!Object.hasOwn(requests[0].body.state,'queryLabel'));
    const rejected=await classifyListings({items:[items[0]],config:{ai:{...config.ai,model:'qwen3:4b'}}});
    assert.equal(rejected.aiUsed,false); assert.equal(requests.length,4);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
