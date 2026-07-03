exports.handler = async (event) => {
  const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
  if (event.httpMethod==='OPTIONS') return {statusCode:204,headers:cors,body:''};
  try {
    const body = JSON.parse(event.body||'{}');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('[estimate] ANTHROPIC_API_KEY is missing or empty in environment');
    }
    const r = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:body.model||'claude-sonnet-4-6',max_tokens:body.max_tokens||1000,messages:body.messages,system:body.system||undefined})});
    const data = await r.json();
    if (!r.ok || data.type === 'error') {
      console.error('[estimate] Anthropic API error. status=' + r.status + ' body=' + JSON.stringify(data));
    } else if (!data.content) {
      console.error('[estimate] Unexpected response shape, no content field. body=' + JSON.stringify(data));
    }
    return {statusCode:200,headers:{...cors,'Content-Type':'application/json'},body:JSON.stringify(data)};
  } catch(e) {
    console.error('[estimate] Handler threw: ' + e.message);
    return {statusCode:500,headers:{...cors,'Content-Type':'application/json'},body:JSON.stringify({error:e.message})};
  }
};
