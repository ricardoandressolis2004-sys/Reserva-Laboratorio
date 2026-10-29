import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { SUBJECTS, todayInTz } from "@/lib/lab-constants";
import {
  getConfig,
  loadStudent,
  readSession,
  serviceRole,
  teamsWindowOpen,
} from "@/lib/lab-auth.server";

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

const view = (team, today) => ({
  id: team.id,
  subject: team.subject,
  team_number: team.team_number || "",
  has_number: !!team.has_number,
  members: team.members || [],
  owner_matricula: team.owner_matricula,
  sanctioned_until: team.sanctioned_until || "",
  sanctioned: !!team.sanctioned_until && today <= team.sanctioned_until,
});

export const getStudentTeams = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "student") return fail("Sesión no válida.");
    const student = await loadStudent(srp, session.user_id);
    if (!student) return fail("Cuenta no encontrada.");

    const today = todayInTz();
    const config = await getConfig(srp);
    const teams = await srp.entities.Team.list("-created_date", 500);
    const mine = teams.filter((t) => (t.members || []).includes(student.matricula)).map((t) => view(t, today));

    const reservations = (await srp.entities.Reservation.filter({ status: "active" }, { limit: 300 })).items || [];
    const schedules = mine.map((team) => {
      const booked = reservations
        .filter((r) => r.team_id === team.id)
        .sort((a, b) => (a.reservation_date + a.block).localeCompare(b.reservation_date + b.block))
        .map((r) => ({ id: r.id, date: r.reservation_date, block: r.block, practice: r.practice, plc: r.plc, mps: r.mps }));
      return { team_id: team.id, subject: team.subject, booked };
    });

    return ok({
      teams: mine,
      schedules,
      windowOpen: teamsWindowOpen(config),
      config: {
        teams_enabled: !!config.teams_enabled,
        teams_start: config.teams_start || "",
        teams_end: config.teams_end || "",
      },
    });
  });

export const createTeam = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      subject: z.string(),
      teamNumber: z.string().optional(),
      hasNumber: z.boolean(),
      members: z.array(z.string()),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "student") return fail("Sesión no válida.");
    const student = await loadStudent(srp, session.user_id);
    if (!student) return fail("Cuenta no encontrada.");

    const config = await getConfig(srp);
    if (!teamsWindowOpen(config)) return fail("La creación de equipos está cerrada en este momento.");
    if (!SUBJECTS.includes(data.subject)) return fail("Selecciona una materia válida.");

    const number = (data.teamNumber || "").trim();
    if (data.hasNumber) {
      if (!/^\d{1,4}$/.test(number)) return fail("El número de equipo debe contener solo dígitos.");
    }

    const matriculas = Array.from(new Set([student.matricula, ...data.members.map((m) => m.trim()).filter(Boolean)]));
    if (matriculas.some((m) => !/^\d{8}$/.test(m))) return fail("Cada integrante debe tener una matrícula de 8 dígitos.");
    if (matriculas.length > 10) return fail("Un equipo no puede tener más de 10 integrantes.");

    const allStudents = await srp.entities.Student.list("-created_date", 1000);
    const known = new Set(allStudents.map((s) => s.matricula));
    const missing = matriculas.filter((m) => !known.has(m));
    if (missing.length) return fail(`No encontramos estas matrículas: ${missing.join(", ")}`);

    const teams = await srp.entities.Team.list("-created_date", 500);

    for (const matricula of matriculas) {
      const already = teams.find((t) => t.subject === data.subject && (t.members || []).includes(matricula));
      if (already) {
        return fail(`La matrícula ${matricula} ya pertenece a un equipo de ${data.subject}.`);
      }
    }
    const myTeams = teams.filter((t) => (t.members || []).includes(student.matricula));
    if (myTeams.length >= 3) return fail("Solo puedes pertenecer a 3 equipos (uno por materia).");

    const created = await srp.entities.Team.create({
      subject: data.subject,
      team_number: data.hasNumber ? number : "",
      has_number: !!data.hasNumber,
      members: matriculas,
      owner_matricula: student.matricula,
    });
    return ok({ team: view(created, todayInTz()) });
  });