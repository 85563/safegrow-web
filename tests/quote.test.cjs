const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const good = (code = "005930", overrides = {}) => ({
  ok: true, code, price: "209000", change: "-9000", changeRate: "-4.13",
  ...overrides
});
const response = (data, ok = true) => ({ ok, json: async () => data });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function harness(fetchImpl) {
  const nodes = new Map();
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {
        value: "", textContent: "", style: {}, attrs: {}, events: {},
        setAttribute(key, value) { this.attrs[key] = value; },
        addEventListener(key, handler) { this.events[key] = handler; }
      });
      return nodes.get(id);
    }
  };
  const context = vm.createContext({
    document, AbortController, Intl, encodeURIComponent,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { calls.push({ url, options }); return fetchImpl(url, options); }
  });
  vm.runInContext(script, context);
  return {
    calls, timers, context,
    node: id => document.getElementById(id),
    search(name = "삼성전자") {
      document.getElementById("stockInput").value = name;
      return context.searchStock();
    },
    expire() { for (const {fn, ms} of [...timers.values()]) { assert.equal(ms, 10000); fn(); } }
  };
}
function assertCleared(h) {
  assert.equal(h.node("result").style.display, "none");
  for (const id of ["stockName", "stockCode", "stockPrice", "stockChangeAmount", "stockChange"]) {
    assert.equal(h.node(id).textContent, "");
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("three names, leading-zero codes, positive/negative/zero display and request boundary", async () => {
  const cases = [
    ["삼성전자", "005930", "-9000", "-4.13", "-9,000원", "-4.13%"],
    ["SK하이닉스", "000660", "+1000", "+1.25", "+1,000원", "+1.25%"],
    ["NAVER", "035420", "-0", "0.00", "0원", "0%"]
  ];
  for (const [name, code, change, changeRate, amountText, rateText] of cases) {
    const h = harness(async () => response(good(code, {change, changeRate})));
    await h.search(name);
    assert.equal(h.node("stockName").textContent, name);
    assert.equal(h.node("stockCode").textContent, code);
    assert.equal(h.node("stockPrice").textContent, "209,000원");
    assert.equal(h.node("stockChangeAmount").textContent, amountText);
    assert.equal(h.node("stockChange").textContent, rateText);
    assert.equal(h.node("result").style.display, "block");
    assert.equal(h.node("result").attrs["aria-busy"], "false");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, "https://safegrow-api.zzaho0827.workers.dev/price?code=" + code);
    assert.equal(h.calls[0].options.method, "GET");
    assert.equal(h.calls[0].options.credentials, "omit");
    assert.equal(h.calls[0].options.headers, undefined);
    assert.equal(h.calls[0].options.mode, undefined);
    assert.equal(h.timers.size, 0);
  }
});
test("Enter searches, composing Enter does not issue a request", async () => {
  const h = harness(async () => response(good()));
  h.node("stockInput").value = " 삼성전자 ";
  let prevented = false;
  h.node("stockInput").events.keydown({key:"Enter", isComposing:true});
  assert.equal(h.calls.length, 0);
  h.node("stockInput").events.keydown({key:"Enter", isComposing:false, preventDefault(){prevented=true;}});
  await flush();
  assert.equal(prevented, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.node("stockCode").textContent, "005930");
});
test("loading clears old results immediately; invalid names never fetch", async () => {
  const pending = deferred();
  let count = 0;
  const h = harness(() => ++count === 1 ? Promise.resolve(response(good())) : pending.promise);
  await h.search();
  const request = h.search("NAVER");
  assertCleared(h);
  assert.equal(h.node("result").attrs["aria-busy"], "true");
  assert.match(h.node("message").textContent, /조회하고/);
  await h.search("toString");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.signal.aborted, true);
  pending.resolve(response(good("035420")));
  await request;
  assertCleared(h);
  assert.match(h.node("message").textContent, /입력해/);
});
test("HTTP, JSON, network errors never reveal raw details or retain a previous result", async t => {
  const marker = "PRIVATE_ERROR_BODY";
  const failures = {
    HTTP: async () => ({ ok:false, json(){throw new Error(marker);} }),
    JSON: async () => ({ ok:true, async json(){throw new Error(marker);} }),
    network: async () => { throw new Error(marker); }
  };
  for (const [name, fail] of Object.entries(failures)) {
    await t.test(name, async () => {
      let first = true;
      const h = harness((...args) => {
        if (first) {first=false;return Promise.resolve(response(good()));}
        return fail(...args);
      });
      await h.search();
      await h.search();
      assertCleared(h);
      assert.equal(h.node("message").textContent, "현재가를 조회하지 못했습니다. 잠시 후 다시 검색해 주세요.");
      assert.equal(h.calls.length, 2);
      assert.equal(h.timers.size, 0);
    });
  }
});
test("reject invalid envelopes, mismatched code and non-decimal/non-finite numbers", async t => {
  const invalid = [
    null, [], {}, good("000660"), good(5930), good("005930", {ok:"true"}),
    good("005930", {ok:false}), good("005930", {price:"0"}), good("005930", {price:"-1"})
  ];
  for (const field of ["price", "change", "changeRate"]) {
    for (const value of ["", " ", "NaN", "Infinity", "-Infinity", "1e309", "0x10", "1,000", "1원",
      "1.2.3", "1\n2", "9".repeat(400), null, undefined, 100, true, {}]) {
      invalid.push(good("005930", {[field]:value}));
    }
  }
  for (let i=0; i<invalid.length; i++) {
    await t.test("invalid payload " + i, async () => {
      const h = harness(async () => response(invalid[i]));
      await h.search();
      assertCleared(h);
      assert.match(h.node("message").textContent, /조회하지 못했습니다/);
      assert.equal(h.timers.size, 0);
    });
  }
});
test("timeout aborts a pending fetch without retry; late success stays hidden", async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const request = h.search();
  h.expire();
  assert.equal(h.calls[0].options.signal.aborted, true);
  assertCleared(h);
  assert.match(h.node("message").textContent, /시간이 초과/);
  pending.resolve(response(good()));
  await request;
  assertCleared(h);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});
test("timeout covers JSON body reading and abort rejection", async () => {
  const body = deferred();
  const h = harness(async () => ({ok:true,json:()=>body.promise}));
  const request = h.search();
  await flush();
  h.expire();
  body.reject(new Error("PRIVATE_ERROR_BODY"));
  await request;
  assertCleared(h);
  assert.match(h.node("message").textContent, /시간이 초과/);
  assert.equal(h.timers.size, 0);
});
test("late previous success or failure cannot overwrite latest result or busy state", async t => {
  for (const reject of [false, true]) {
    await t.test(reject ? "late failure" : "late success", async () => {
      const old = deferred();
      let first = true;
      const h = harness(() => {
        if(first){first=false;return old.promise;}
        return Promise.resolve(response(good("035420", {price:"100000",change:"0",changeRate:"0"})));
      });
      const previous = h.search();
      await h.search("NAVER");
      assert.equal(h.calls[0].options.signal.aborted, true);
      if(reject)old.reject(new Error("PRIVATE_ERROR_BODY"));else old.resolve(response(good()));
      await previous;
      assert.equal(h.node("stockName").textContent, "NAVER");
      assert.equal(h.node("stockPrice").textContent, "100,000원");
      assert.equal(h.node("result").attrs["aria-busy"], "false");
      assert.equal(h.timers.size, 0);
    });
  }
});
test("static safety: disabled orders, no fake quote table or raw logging", () => {
  assert.match(html, /class="disabled-button"[\s\S]*?disabled/);
  assert.match(html, /onclick="searchStock\(\)"/);
  assert.doesNotMatch(html, /testStocks|테스트 가격|테스트 등락률|500,000원/);
  assert.doesNotMatch(script, /console\.|localStorage|sessionStorage|no-cors|setInterval|KIS_APP_/);
});

