import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
const files = readdirSync(directory).filter((name) => /^jiemian-lists-.*\.mjs$/.test(name));
assert.equal(files.length, 1, 'Expected one bundled Jiemian list route');
const path = join(directory, files[0]);
let source = readFileSync(path, 'utf8');

function replaceOnce(before, after) {
  assert.equal(source.split(before).length, 2, 'RSSHub source changed; review the route patches');
  source = source.replace(before, after);
}

// The legacy API intermittently returns 404 even though the category page works.
// Send its Referer and, on 404 only, parse the category's already-rendered cards.
// Keep the existing limit, article parser, full-text extraction, and feed identity.
replaceOnce(
  'let m=await e(`https://a.jiemian.com/index.php`,{query:{',
  'let m=await e(`https://a.jiemian.com/index.php`,{headers:{Referer:u},query:{',
);
replaceOnce(
  'list_type:p.attr(`data-list_type`)}}),{html:h}',
  'list_type:p.attr(`data-list_type`)}}).catch(error=>{if(error.statusCode!==404)throw error;const html=f(`#load-list`).html();if(!html||n(html).length===0)throw error;console.warn(`Jiemian load-more returned 404; using rendered category cards: ${u}`);return `(${JSON.stringify({html})})`}),{html:h}',
);
writeFileSync(path, source);

const podcastFiles = readdirSync(directory).filter((name) =>
  /^xiaoyuzhou-podcast-.*\.mjs$/.test(name),
);
assert.equal(podcastFiles.length, 1, 'Expected one bundled Xiaoyuzhou podcast route');
const podcastPath = join(directory, podcastFiles[0]);
source = readFileSync(podcastPath, 'utf8');
// Match the original xyzfm RSS links: article IDs hash the entire URL, including
// this query parameter. Keeping it preserves stars and playback progress.
replaceOnce(
  'link:`https://www.xiaoyuzhoufm.com/episode/${e.eid}`',
  'link:`https://www.xiaoyuzhoufm.com/episode/${e.eid}?utm_source=rss`',
);
writeFileSync(podcastPath, source);
