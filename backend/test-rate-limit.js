const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0YW5pc2hhYWdhcndhbGEyNTEwQGdtYWlsLmNvbSIsImlhdCI6MTc4ODU4OTQ0NCwiZXhwIjoxNzg5MTk0MjQ0fQ.3tT9PyiJBquRimMYRxexDWRlovmcIwVZuNNmDB6fw7Q";

async function run() {
  for (let i = 1; i <= 35; i++) {
    const res = await fetch("http://localhost:4000/api/watchlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ symbol: `TEST${i}` }),
    });
    console.log(`Request ${i}: ${res.status}`);
  }
}

run();