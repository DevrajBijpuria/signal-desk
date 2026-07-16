// YouTube commentary channels, grouped by section. Edit this file to add or
// remove channels — the fetch logic in commentary.mjs never needs to change.
// IDs were resolved from each channel's @handle page ("externalId" in the page
// source; the first "channelId" hit can belong to a related channel) and
// verified against https://www.youtube.com/feeds/videos.xml?channel_id={ID}.
export const COMMENTARY_CHANNELS = {
  tech: [
    { id: "UCNJ1Ymd5yFuUPtn21xtRbbw", name: "AI Explained" },      // @aiexplained-official
    { id: "UCZHmQk67mSJgfCCTn7xBfew", name: "Yannic Kilcher" },
    { id: "UCqcbQf6yw5KzRoDDcZ_wBSw", name: "Wes Roth" },          // @WesRoth
    { id: "UChpleBmo18P08aKCIgti38g", name: "Matt Wolfe" },        // @mreflow
    { id: "UCbfYPyITQ-7l4upoX8nvctg", name: "Two Minute Papers" }, // @TwoMinutePapers
    { id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship" },          // @Fireship
    { id: "UCvKRFNawVcuz4b9ihUTApCg", name: "David Shapiro" },     // @DaveShap
  ],
  geopolitics: [
    { id: "UCC3ehuUksTyQ7bbjGntmx3Q", name: "Perun" },             // @PerunAU
    { id: "UCsy9I56PY3IngCf_VGjunMQ", name: "Zeihan on Geopolitics" }, // @ZeihanonGeopolitics
    { id: "UCwnKziETDbHJtx78nIkfYug", name: "CaspianReport" },     // @CaspianReport
    { id: "UC1LpsuAUaKoMzzJSEt5WImw", name: "Asianometry" },       // @Asianometry
    { id: "UCVWX3F3DrTvDKa0LRilQoQQ", name: "Context Matters" },   // @ContextMatters
  ],
  india: [
    { id: "UC0yXUUIaPVAqZLgRjvtMftw", name: "Ravish Kumar Official" }, // @ravishkumar.official — NOT @RavishKumarOfficial ("…Officialf"), a dormant impersonator
    { id: "UCXCG3leC3eHChlU2OPWMk_A", name: "Punya Prasun Bajpai" },   // @PunyaPrasunBajpai
    { id: "UCmTM_hPCeckqN3cPWtYZZcg", name: "The Deshbhakt" },         // @TheDeshBhakt
    { id: "UCuyRsHZILrU7ZDIAbGASHdA", name: "ThePrint" },             // @ThePrintIndia
    { id: "UCrYpceU8cvXNSqaiYC-8hJA", name: "Satya Hindi" },          // @SatyaHindi
    { id: "UCustbySVJGb659WDpdkeATg", name: "Newslaundry" },          // @Newslaundry
    { id: "UC5fcjujOsqD-126Chn_BAuA", name: "Sarthak Goswami" },      // @SarthakGoswami
  ],
  esportsGlobal: [
    { id: "UCEOQ9pSmMEIqfhtCDa2JORw", name: "Richard Lewis" },
    { id: "UCfeeUuW7edMxF3M_cyxGT8Q", name: "Thorin" },
  ],
  esportsIndia: [
    { id: "UC9rU4WGvK8d1oD2yec7UtVw", name: "AFK Gaming" },
  ],
};
