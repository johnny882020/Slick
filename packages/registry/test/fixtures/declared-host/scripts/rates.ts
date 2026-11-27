// Fetch today's rate from the one declared host.
const [from = "EUR", to = "USD"] = Deno.args;
const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
const data = await res.json();
console.log(JSON.stringify({ date: data.date, rate: data.rates[to] }));
