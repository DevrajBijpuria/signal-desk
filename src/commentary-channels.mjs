// YouTube commentary channels, grouped by section. Edit this file to add or
// remove channels — the fetch logic in commentary.mjs never needs to change.
// IDs were resolved from each channel's @handle page ("externalId" in the page
// source; the first "channelId" hit can belong to a related channel) and
// verified against https://www.youtube.com/feeds/videos.xml?channel_id={ID}.
export const COMMENTARY_CHANNELS = {
  tech: [
    { id: "UCNJ1Ymd5yFuUPtn21xtRbbw", name: "AI Explained" },      // @aiexplained-official
    { id: "UCZHmQk67mSJgfCCTn7xBfew", name: "Yannic Kilcher" },
  ],
  geopolitics: [
    { id: "UCC3ehuUksTyQ7bbjGntmx3Q", name: "Perun" },             // @PerunAU
    { id: "UCsy9I56PY3IngCf_VGjunMQ", name: "Zeihan on Geopolitics" }, // @ZeihanonGeopolitics
    { id: "UCwnKziETDbHJtx78nIkfYug", name: "CaspianReport" },     // @CaspianReport
  ],
  // Placeholder slot, not a bug — no India commentary channels picked yet.
  india: [],
  esportsGlobal: [
    { id: "UCEOQ9pSmMEIqfhtCDa2JORw", name: "Richard Lewis" },
    { id: "UCfeeUuW7edMxF3M_cyxGT8Q", name: "Thorin" },
  ],
  esportsIndia: [
    { id: "UC9rU4WGvK8d1oD2yec7UtVw", name: "AFK Gaming" },
  ],
};
