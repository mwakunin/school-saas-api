import type { Rng } from "./random";

/**
 * Kenyan names, with the regional spread CLAUDE.md §8 asks for by name.
 *
 * This is the detail a head teacher notices in the first ten seconds. A
 * register of Faker defaults — Jennifer Smith, Michael Johnson — says the
 * product was built for somewhere else and this school is an afterthought. A
 * register of Wanjikus and Otienos and Chebets says somebody has seen a
 * Kenyan class list.
 *
 * Grouped by community rather than pooled, because the pairing is what makes
 * it read as real: a child called Achieng' has a Luo family name, not a
 * Kalenjin one. Intermarriage is common and the generator allows it (see
 * `familyFrom`), but as the exception it is rather than the default.
 *
 * Most children carry an English or Christian given name alongside the one
 * their community gave them, which is why `middleNames` is where the second
 * one goes — matching how a Kenyan register is actually written.
 */

export interface Community {
  name: string;
  /** Names given to girls. */
  female: string[];
  /** Names given to boys. */
  male: string[];
  family: string[];
}

export const COMMUNITIES: Community[] = [
  {
    name: "Kikuyu",
    female: ["Wanjiku", "Wairimu", "Nyambura", "Wambui", "Njeri", "Muthoni", "Wangari"],
    male: ["Kamau", "Mwangi", "Kariuki", "Macharia", "Ndungu", "Githaiga"],
    family: ["Njoroge", "Kamau", "Mwangi", "Kariuki", "Wanjiru", "Macharia"],
  },
  {
    name: "Luo",
    female: ["Achieng'", "Adhiambo", "Akinyi", "Atieno", "Anyango", "Awuor"],
    male: ["Otieno", "Ochieng'", "Odhiambo", "Onyango", "Omondi", "Owino"],
    family: ["Otieno", "Ochieng'", "Odhiambo", "Onyango", "Omondi", "Oduya"],
  },
  {
    name: "Kalenjin",
    female: ["Chebet", "Jepkosgei", "Cherono", "Jerotich", "Chelangat"],
    male: ["Kiplagat", "Kiprono", "Kipchoge", "Kibet", "Kipkorir", "Rotich"],
    family: ["Kiplagat", "Rotich", "Kipchoge", "Chelimo", "Kirui"],
  },
  {
    name: "Kamba",
    female: ["Mwikali", "Ndinda", "Mueni", "Katungwa", "Nzula"],
    male: ["Mutua", "Musyoka", "Kioko", "Mutiso", "Muthama"],
    family: ["Mutua", "Musyoka", "Kioko", "Ndeti", "Muthama"],
  },
  {
    name: "Luhya",
    female: ["Nasimiyu", "Nekesa", "Naliaka", "Khakasa", "Nanjala"],
    male: ["Wafula", "Barasa", "Wanyonyi", "Simiyu", "Wekesa"],
    family: ["Wanyonyi", "Barasa", "Wafula", "Simiyu", "Makokha"],
  },
  {
    name: "Kisii",
    female: ["Nyaboke", "Kemunto", "Bosibori", "Moraa"],
    male: ["Ombati", "Nyakundi", "Onchiri", "Mogaka"],
    family: ["Ombati", "Nyakundi", "Mogaka", "Onchiri"],
  },
  {
    name: "Somali",
    female: ["Amina", "Fatuma", "Halima", "Sagal", "Ubah"],
    male: ["Hassan", "Abdi", "Omar", "Yusuf", "Ahmed"],
    family: ["Hassan", "Abdi", "Noor", "Farah", "Yusuf"],
  },
  {
    name: "Coastal",
    female: ["Mwanaisha", "Zuhura", "Riziki", "Neema"],
    male: ["Salim", "Juma", "Bakari", "Rashid"],
    family: ["Salim", "Juma", "Bakari", "Mwinyi"],
  },
  {
    name: "Maasai",
    female: ["Naserian", "Nasieku", "Namunyak", "Sironka"],
    male: ["Lemayian", "Saitoti", "Ntimama", "Sankale"],
    family: ["Ole Sankale", "Saitoti", "Lemayian", "Ntimama"],
  },
];

/**
 * The English or Christian name that usually comes first on a register.
 *
 * Weighted towards names that were common when these children were born —
 * roughly 2015–2022 — rather than a generic list. A Grade 4 class with three
 * Blessings and two Shanils reads right; one full of mid-century names does
 * not.
 */
const GIVEN_FEMALE = [
  "Grace",
  "Faith",
  "Mercy",
  "Joy",
  "Blessing",
  "Precious",
  "Cynthia",
  "Brenda",
  "Sharon",
  "Vivian",
  "Esther",
  "Naomi",
  "Lydia",
  "Purity",
  "Shanil",
  "Angel",
  "Michelle",
  "Stacy",
  "Ivy",
  "Tabitha",
  "Ruth",
  "Winnie",
];

const GIVEN_MALE = [
  "Brian",
  "Kevin",
  "Collins",
  "Dennis",
  "Victor",
  "Emmanuel",
  "Elvis",
  "Ian",
  "Felix",
  "Alvin",
  "Bramwell",
  "Gideon",
  "Samuel",
  "Peter",
  "Joseph",
  "Mark",
  "Trevor",
  "Lewis",
  "Nathan",
  "Isaac",
  "Elijah",
  "Cyrus",
];

/** Names a guardian's generation carries — an older pool than their children's. */
const GUARDIAN_FEMALE = [
  "Margaret",
  "Jane",
  "Rose",
  "Alice",
  "Beatrice",
  "Eunice",
  "Susan",
  "Agnes",
  "Monica",
  "Priscilla",
  "Damaris",
  "Hellen",
  "Consolata",
];

const GUARDIAN_MALE = [
  "Peter",
  "John",
  "James",
  "Simon",
  "Charles",
  "Patrick",
  "Francis",
  "Daniel",
  "George",
  "Stephen",
  "Anthony",
  "Boniface",
  "Wycliffe",
];

export interface PersonName {
  givenName: string;
  middleNames: string;
  familyName: string;
  sex: "male" | "female";
  community: Community;
}

export function childName(rng: Rng, community?: Community): PersonName {
  const from = community ?? rng.pick(COMMUNITIES);
  const sex = rng.chance(0.5) ? "male" : "female";

  return {
    givenName: rng.pick(sex === "male" ? GIVEN_MALE : GIVEN_FEMALE),
    middleNames: rng.pick(sex === "male" ? from.male : from.female),
    familyName: rng.pick(from.family),
    sex,
    community: from,
  };
}

/**
 * A guardian's name, sharing the child's family name most of the time.
 *
 * Most of the time and not always, deliberately. A mother who kept her own
 * name, a grandmother, an uncle standing in — these are ordinary, and a demo
 * where every guardian surname matches the child's teaches a bursar to expect
 * something the real register will not give them.
 */
export function guardianName(
  rng: Rng,
  child: PersonName,
  sex: "male" | "female",
): { name: string } {
  const given = rng.pick(sex === "male" ? GUARDIAN_MALE : GUARDIAN_FEMALE);
  const middle = rng.pick(sex === "male" ? child.community.male : child.community.female);
  const family = rng.chance(0.8)
    ? child.familyName
    : rng.pick(child.community.family);

  return { name: `${given} ${middle} ${family}` };
}
