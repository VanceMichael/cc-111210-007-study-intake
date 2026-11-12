import { get } from './http.mjs';
export function attribute(dataset, tag) { const item=dataset[tag]; return item ? {vr:item.vr,values:item.Value??null,bulk:item.BulkDataURI??null}:null; }
export async function inspect(base) { const rows=await (await get(base,'/studies/1/instances')).json(); return {count:rows.length,instances:rows.map(row=>({study:attribute(row,'0020000D'),series:attribute(row,'0020000E'),instance:attribute(row,'00080018'),pixels:attribute(row,'7FE00010')}))}; }
