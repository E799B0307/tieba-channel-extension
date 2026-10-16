const store = new Map();
globalThis.chrome = {
  storage: {
    session: { async get(k){const l=Array.isArray(k)?k:[k];const o={};for(const x of l)if(store.has(x))o[x]=store.get(x);return o;}, async set(o){for(const[k,v]of Object.entries(o))store.set(k,v);}, async clear(){store.clear();}, async remove(k){store.delete(k);} },
    local:   { async get(k){const l=Array.isArray(k)?k:[k];const o={};for(const x of l)if(store.has(x))o[x]=store.get(x);return o;}, async set(o){for(const[k,v]of Object.entries(o))store.set(k,v);}, async remove(k){store.delete(k);} },
  },
  runtime: { id: "test", async sendMessage(){ return null; }, getURL(p){ return "chrome-extension://test/" + p; } },
};

const { parseMessage } = await import("./protocol.js");

let ok = 0, bad = 0;
const t = (l, a, e) => { const p = JSON.stringify(a) === JSON.stringify(e); p ? ok++ : bad++; console.log(`${p ? "PASS" : "FAIL"}  ${l}${p ? "" : ` 期望${JSON.stringify(e)} 实际${JSON.stringify(a)}`}`); };

// parseMessage 是发送端间接依赖（历史消息/自己的消息都要经由它回显）
const raw = {
  msgid: 12345, create_time: 1700000000, msg_key: "k1", from_user: 555,
  content: JSON.stringify({ text: JSON.stringify({
    type: "0", name: "路人甲", content_type: "0",
    content_body: JSON.stringify({ text: "你好" }),
    baidu_uk: "UK555", portrait: "tb.1.abc", room_id: "999",
    at_data: [
      { at_type: "user", at_name: "小明", uid: 777 },
      { at_type: "all", at_name: "全体成员" },
    ],
    ext: JSON.stringify({ main_data: [{ type: 1, text: { str: "路人甲" } }], level: 12 }),
  }) }),
};

const parsed = parseMessage(raw);
t("id", parsed.id, "12345");
t("name", parsed.name, "路人甲");
t("text", parsed.text, "你好");
t("authorId", parsed.authorId, "UK555");
t("room", parsed.room, "999");
t("atNames", parsed.atNames, ["小明"]);
t("atUids", parsed.atUids, [777]);
t("atAll", parsed.atAll, true);

// 无 at_data 的消息不应崩溃（普通发送走这条）
const plain = parseMessage({
  msgid: 1, create_time: 1, from_user: 1,
  content: JSON.stringify({ text: JSON.stringify({ type: "0", name: "A", content_body: "{}" }) }),
});
t("无at_data不崩溃", plain.atNames, []);
t("无at_data atAll=false", plain.atAll, false);

// 关键：消息经 JSON 序列化往返（send 构造 content 再经网络回传解析）
const roundTrip = parseMessage(JSON.parse(JSON.stringify(raw)));
t("序列化往返一致", roundTrip.atUids, [777]);

console.log(`\n通过 ${ok}，失败 ${bad}`);
process.exit(bad ? 1 : 0);
