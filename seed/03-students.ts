import type { SchoolContext } from "./01-school";
import type { PersonName } from "./lib/names";

import { day, intakeYear, TERM_OFFSETS } from "./lib/calendar";
import { childName, COMMUNITIES, guardianName } from "./lib/names";
import { Rng } from "./lib/random";

/**
 * ~320 children, their guardians, and the enrolments that place them.
 *
 * The register is the first screen anybody looks at, so the realism budget
 * goes here: names with the right regional spread, admission numbers that
 * carry their intake year, siblings who share a parent, and one child who left
 * mid-term with their history intact.
 */

/** Roughly 22 to a primary class, a little smaller in junior school. */
const CLASS_SIZE: Record<"primary" | "junior", [number, number]> = {
  primary: [21, 24],
  junior: [17, 20],
};

export interface SeededPupil {
  id: string;
  admissionNumber: string;
  name: PersonName;
  streamId: string;
  gradeSequence: number;
  enrollmentId: string;
  boardingStatus: "day" | "boarder";
}

export interface Register {
  pupils: SeededPupil[];
  /** By stream id, in the order a class list would print. */
  byStream: Map<string, SeededPupil[]>;
  /** The child who transferred out mid-term — their marks and fees remain. */
  leaver: SeededPupil;
  /** The two families with a child in more than one class. */
  siblingGroups: Array<{ guardianId: string; guardianName: string; pupils: SeededPupil[] }>;
  /** The pupil the demo parent login can see. */
  parentsChild: SeededPupil;
}

export async function seedStudents(ctx: SchoolContext): Promise<Register> {
  const rng = new Rng(20260101);
  const office = ctx.api("head");

  const pupils: SeededPupil[] = [];
  const byStream = new Map<string, SeededPupil[]>();

  /*
   * Admission numbers run `intake year / serial`, and the serial runs across
   * the whole intake rather than per class.
   *
   * This is what a bursar reads first. `2023/041` is a child who started in
   * Grade 1 three years ago; `2026/118` started this year. It also doubles as
   * the M-Pesa account reference (CLAUDE.md §5.3), which is why 05-fees.ts can
   * build a plausibly mistyped reference out of it.
   */
  const serialByYear = new Map<number, number>();
  const nextAdmissionNumber = (gradeSequence: number) => {
    const year = intakeYear(gradeSequence);
    const serial = (serialByYear.get(year) ?? 0) + 1;
    serialByYear.set(year, serial);
    return `${year}/${String(serial).padStart(3, "0")}`;
  };

  for (const stream of ctx.streams) {
    const grade = ctx.gradeLevels.find(g => g.id === stream.gradeLevelId)!;
    const phase = grade.phase as "primary" | "junior";
    const [min, max] = CLASS_SIZE[phase];
    const size = rng.int(min, max);
    const roll: SeededPupil[] = [];

    for (let i = 0; i < size; i++) {
      const name = childName(rng);
      const admissionNumber = nextAdmissionNumber(stream.sequence);

      /*
       * Boarding is a junior-school thing here, and only for some.
       *
       * It is not decoration: `boardingStatus` picks which fee structure a
       * child is billed from, so a school with both is what proves the fee run
       * charges two different amounts in the same class.
       */
      const boardingStatus: "day" | "boarder"
        = phase === "junior" && rng.chance(0.35) ? "boarder" : "day";

      // Six years old in Grade 1, and a birthday somewhere in the year.
      const ageYears = 5 + stream.sequence;
      const dateOfBirth = day(-(ageYears * 365 + rng.int(0, 364)));

      const student = await office.post("/students", {
        admissionNumber,
        givenName: name.givenName,
        middleNames: name.middleNames,
        familyName: name.familyName,
        sex: name.sex,
        dateOfBirth,
        // Admitted at the start of the year they joined, which is what makes
        // the intake year in the admission number true rather than decorative.
        admittedOn: day(TERM_OFFSETS[0].startsOn - (stream.sequence - 1) * 365),
        enrollment: {
          streamId: stream.id,
          boardingStatus,
          startedOn: day(TERM_OFFSETS[0].startsOn),
        },
      });

      const pupil: SeededPupil = {
        id: student.id,
        admissionNumber,
        name,
        streamId: stream.id,
        gradeSequence: stream.sequence,
        enrollmentId: student.currentEnrollment.id,
        boardingStatus,
      };

      pupils.push(pupil);
      roll.push(pupil);
    }

    byStream.set(stream.id, roll);
  }

  /*
   * Guardians.
   *
   * A table rather than columns on the child (CLAUDE.md §5.3) because siblings
   * share a parent — and the demo has to show that, or the sibling handling is
   * a claim rather than a demonstration. Most children get one guardian, some
   * get two, and every guardian has a real Kenyan mobile number because that
   * number is the SMS target.
   */
  let phoneSerial = 700_000;
  const nextPhone = () => `+2547${String(phoneSerial++).padStart(8, "0")}`;

  for (const pupil of pupils) {
    const motherFirst = rng.chance(0.65);
    const primary = guardianName(rng, pupil.name, motherFirst ? "female" : "male");

    await office.post(`/students/${pupil.id}/guardians`, {
      guardian: {
        name: primary.name,
        phone: nextPhone(),
        occupation: rng.pick([
          "Teacher",
          "Farmer",
          "Trader",
          "Boda boda rider",
          "Nurse",
          "Mechanic",
          "Tailor",
          "Shopkeeper",
          "Driver",
          "Civil servant",
          "Hairdresser",
        ]),
      },
      relationship: motherFirst ? "mother" : "father",
      isPrimary: true,
      receivesInvoices: true,
    });

    // A second guardian for some, which is what makes "who may collect this
    // child" a question with more than one answer.
    if (rng.chance(0.35)) {
      const second = guardianName(rng, pupil.name, motherFirst ? "male" : "female");
      await office.post(`/students/${pupil.id}/guardians`, {
        guardian: { name: second.name, phone: nextPhone() },
        relationship: motherFirst ? "father" : "mother",
        isPrimary: false,
        // Deliberately not everyone: a second parent who does not want the
        // invoice SMS is ordinary, and a demo where every contact gets
        // everything hides the setting.
        receivesInvoices: rng.chance(0.5),
      });
    }
  }

  /*
   * Two families with a child in two different classes.
   *
   * CLAUDE.md §8 asks for this by name, and it is the case that justifies the
   * whole `guardians` / `student_guardians` split: without it you send the
   * same fee reminder twice and store one phone number two ways. Linking an
   * EXISTING guardian to a second child is the exact call a bursar makes when
   * they notice two children share a parent.
   */
  const siblingGroups: Register["siblingGroups"] = [];

  for (const [older, younger] of [[6, 3], [8, 2]] as const) {
    const olderChild = rng.pick(pupils.filter(p => p.gradeSequence === older));
    const youngerPool = pupils.filter(
      p => p.gradeSequence === younger && p.id !== olderChild.id,
    );
    const youngerChild = rng.pick(youngerPool);

    // The younger sibling takes the older one's family name, because that is
    // what makes them look like siblings on a screen.
    await office.patch(`/students/${youngerChild.id}`, {
      familyName: olderChild.name.familyName,
    });
    youngerChild.name = { ...youngerChild.name, familyName: olderChild.name.familyName };

    const detail = await office.get(`/students/${olderChild.id}`);
    const shared = detail.guardians.find((g: { isPrimary: boolean }) => g.isPrimary);

    await office.post(`/students/${youngerChild.id}/guardians`, {
      guardianId: shared.id,
      relationship: shared.relationship,
      isPrimary: true,
      receivesInvoices: true,
    });

    siblingGroups.push({
      guardianId: shared.id,
      guardianName: shared.name,
      pupils: [olderChild, youngerChild],
    });
  }

  /*
   * The parent login, attached to a real child.
   *
   * Given a sibling pair on purpose: the parent view is what convinces a head
   * that fee follow-up gets easier, and a parent looking at two children at
   * once is the version of that screen worth showing.
   */
  const parentsChild = siblingGroups[0].pupils[0];

  /*
   * One child who transferred out mid-term.
   *
   * CLAUDE.md §8 asks for it, and it is the case that catches a whole class of
   * bug: their marks, their invoices and their term results all still exist
   * and stay queryable, because nothing hard-deletes (rule 5) and term results
   * cover everyone enrolled DURING the term rather than everyone enrolled now.
   * A register that quietly lost them would look fine until somebody asked for
   * last term's report card.
   *
   * Exited a fortnight ago — inside the current term, so the demo shows a
   * child who was taught this term and is no longer here.
   */
  const leaver = rng.pick(pupils.filter(p => p.gradeSequence === 5));
  await office.post(`/students/${leaver.id}/exit`, {
    status: "transferred_out",
    exitedOn: day(-14),
  });

  return { pupils, byStream, leaver, siblingGroups, parentsChild };
}

/** Communities, re-exported so the summary can report the spread it produced. */
export { COMMUNITIES };
