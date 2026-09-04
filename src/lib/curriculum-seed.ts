/**
 * A starting curriculum a school copies at onboarding.
 *
 * CLAUDE.md §5.4: a school that opens the app and finds Grade 4 Mathematics
 * already broken into its strands believes you know their world; one that finds
 * empty forms closes the tab. This is that structure.
 *
 * **The learning areas are real. The strands are placeholders.**
 *
 * The area names and the primary/junior split follow the CBE curriculum as
 * taught, and are worth getting right because a school recognises them
 * instantly. The strands and sub-strands beneath them are plausible shapes
 * rather than transcriptions of KICD's published designs — enough for a school
 * to see how the tree works and start editing, not enough to hand a teacher and
 * call it the curriculum.
 *
 * Replacing them is a data change and nothing else: the tables, the API and the
 * report card do not care where a strand came from. Until then, every seeded
 * strand is marked `placeholder: true` so a screen can say so honestly rather
 * than letting a teacher assume it is authoritative.
 */

export interface SeedCompetency {
  code: string;
  title: string;
  children?: SeedCompetency[];
}

export interface SeedLearningArea {
  name: string;
  code: string;
  /** Which phase teaches it. Junior school carries areas primary does not. */
  phase: "primary" | "junior" | "both";
  isCore: boolean;
  sequence: number;
  strands: SeedCompetency[];
}

/**
 * Two strands per area, two sub-strands each.
 *
 * Deliberately shallow and uniform. A deeper invented tree would look more
 * finished and be more misleading — the point is to show the shape, not to
 * pretend at content.
 */
function placeholderStrands(area: string): SeedCompetency[] {
  return [
    {
      code: "1.0",
      title: `${area}: Strand 1 (placeholder)`,
      children: [
        { code: "1.1", title: "Sub-strand 1.1 (placeholder)" },
        { code: "1.2", title: "Sub-strand 1.2 (placeholder)" },
      ],
    },
    {
      code: "2.0",
      title: `${area}: Strand 2 (placeholder)`,
      children: [
        { code: "2.1", title: "Sub-strand 2.1 (placeholder)" },
        { code: "2.2", title: "Sub-strand 2.2 (placeholder)" },
      ],
    },
  ];
}

function area(
  name: string,
  code: string,
  phase: SeedLearningArea["phase"],
  sequence: number,
  isCore = true,
): SeedLearningArea {
  return { name, code, phase, isCore, sequence, strands: placeholderStrands(name) };
}

/**
 * The learning areas, in the order a Kenyan report card prints them.
 *
 * Languages first, then Mathematics, then the sciences and humanities, with
 * the practical and expressive areas last — which is how the sheets a school
 * already uses are laid out, and the order `sequence` exists to preserve.
 */
export const CURRICULUM_SEED: SeedLearningArea[] = [
  area("English", "ENG", "both", 10),
  area("Kiswahili", "KIS", "both", 20),
  area("Mathematics", "MAT", "both", 30),

  // Primary splits science by phase: lower primary teaches Environmental
  // Activities, upper primary Science and Technology. Both are seeded; a
  // school removes whichever it does not teach.
  area("Environmental Activities", "ENV", "primary", 40),
  area("Science and Technology", "SCI", "primary", 41),

  // Junior school's integrated science and pre-technical studies have no
  // primary equivalent — the reason `phase` exists rather than a grade number.
  area("Integrated Science", "INS", "junior", 42),
  area("Pre-Technical Studies", "PTS", "junior", 43),

  area("Agriculture and Nutrition", "AGN", "both", 50),
  area("Social Studies", "SST", "both", 60),
  area("Religious Education", "RE", "both", 70),
  area("Creative Arts and Sports", "CAS", "both", 80),

  // Not core: schools offer these unevenly, and a report card should not show
  // a blank row for a subject the school does not teach.
  area("Physical and Health Education", "PHE", "primary", 90, false),
];

/** The areas a given phase teaches. */
export function areasForPhase(phase: "primary" | "junior"): SeedLearningArea[] {
  return CURRICULUM_SEED.filter(a => a.phase === phase || a.phase === "both");
}

/** Every seeded strand carries this, so a screen can say what it is. */
export const PLACEHOLDER_MARKER = "(placeholder)";

/** Whether a competency title came from the seed rather than from a school. */
export function isPlaceholder(title: string): boolean {
  return title.includes(PLACEHOLDER_MARKER);
}
