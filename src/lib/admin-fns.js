import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { SUBJECTS, todayInTz } from "@/lib/lab-constants";
import { getConfig, hashPassword, readSession, serviceRole } from "@/lib/lab-auth.server";

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

async function requireAdmin(srp, token) {
  const session = await readSession(srp, token);
  return session?.role === "admin" ? session : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const adminListStudents = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const today = todayInTz();
    const students = await srp.entities.Student.list("matricula", 1000);
    const teams = await srp.entities.Team.list("-created_date", 500);

    const rows = students.map((s) => {
      const mine = teams.filter((t) => (t.members || []).includes(s.matricula));
      return {
        id: s.id,
        matricula: s.matricula,
        first_name: s.first_name,
        last_name: s.last_name,
        teams: mine.map((t) => ({
          id: t.id,
          subject: t.subject,
          team_number: t.team_number || "",
          has_number: !!t.has_number,
          sanctioned: !!t.sanctioned_until && today <= t.sanctioned_until,
          sanctioned_until: t.sanctioned_until || "",
        })),
        sanctioned: mine.some((t) => t.sanctioned_until && today <= t.sanctioned_until),
      };
    });
    return ok({ students: rows });
  });

export const adminUpdateStudent = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      id: z.string(),
      matricula: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const matricula = data.matricula.trim();
    if (!/^\d{8}$/.test(matricula)) return fail("La matrícula debe tener 8 dígitos.");
    if (!data.firstName.trim() || !data.lastName.trim()) return fail("Nombre y apellido son obligatorios.");

    const student = await srp.entities.Student.get(data.id).catch(() => null);
    if (!student) return fail("Estudiante no encontrado.");

    if (matricula !== student.matricula) {
      const other = await srp.entities.Student.filter({ matricula });
      if (other.some((s) => s.id !== student.id)) return fail("Esa matrícula ya está registrada.");
      const teams = await srp.entities.Team.list("-created_date", 500);
      await srp.entities.Team.bulkUpdate(
        teams
          .filter((t) => (t.members || []).includes(student.matricula))
          .map((t) => ({
            id: t.id,
            members: t.members.map((m) => (m === student.matricula ? matricula : m)),
          })),
      );
    }

    await srp.entities.Student.update(data.id, {
      matricula,
      first_name: data.firstName.trim(),
      last_name: data.lastName.trim(),
    });
    return ok();
  });

export const adminDeleteStudent = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), id: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const student = await srp.entities.Student.get(data.id).catch(() => null);
    if (!student) return fail("Estudiante no encontrado.");

    const teams = await srp.entities.Team.list("-created_date", 500);
    await srp.entities.Team.bulkUpdate(
      teams
        .filter((t) => (t.members || []).includes(student.matricula))
        .map((t) => ({ id: t.id, members: t.members.filter((m) => m !== student.matricula) })),
    );
    await srp.entities.Student.delete(data.id);
    return ok();
  });

export const adminListTeams = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const today = todayInTz();
    const teams = await srp.entities.Team.list("-created_date", 500);
    const students = await srp.entities.Student.list("matricula", 1000);
    const byMatricula = new Map(students.map((s) => [s.matricula, s]));

    const rows = teams.map((t) => ({
      id: t.id,
      subject: t.subject,
      team_number: t.team_number || "",
      has_number: !!t.has_number,
      members: t.members || [],
      member_names: (t.members || []).map((m) => {
        const s = byMatricula.get(m);
        return s ? `${s.first_name} ${s.last_name}` : m;
      }),
      sanctioned_until: t.sanctioned_until || "",
      sanctioned: !!t.sanctioned_until && today <= t.sanctioned_until,
    }));
    return ok({ teams: rows });
  });

export const adminUpdateTeam = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      id: z.string(),
      teamNumber: z.string().optional(),
      hasNumber: z.boolean(),
      members: z.array(z.string()),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const team = await srp.entities.Team.get(data.id).catch(() => null);
    if (!team) return fail("Equipo no encontrado.");

    const members = Array.from(new Set(data.members.map((m) => m.trim()).filter(Boolean)));
    if (!members.length) return fail("El equipo necesita al menos un integrante.");
    if (members.some((m) => !/^\d{8}$/.test(m))) return fail("Cada integrante debe tener una matrícula de 8 dígitos.");

    const students = await srp.entities.Student.list("-created_date", 1000);
    const known = new Set(students.map((s) => s.matricula));
    const missing = members.filter((m) => !known.has(m));
    if (missing.length) return fail(`No existen estas matrículas: ${missing.join(", ")}`);

    const teams = await srp.entities.Team.list("-created_date", 500);
    for (const member of members) {
      const clash = teams.find(
        (t) => t.id !== team.id && t.subject === team.subject && (t.members || []).includes(member),
      );
      if (clash) return fail(`La matrícula ${member} ya está en otro equipo de ${team.subject}.`);
    }

    const number = (data.teamNumber || "").trim();
    if (data.hasNumber && !/^\d{1,4}$/.test(number)) return fail("El número de equipo debe contener solo dígitos.");

    await srp.entities.Team.update(data.id, {
      members,
      team_number: data.hasNumber ? number : "",
      has_number: !!data.hasNumber,
    });
    return ok();
  });

export const adminDeleteTeam = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), id: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const reservations = (await srp.entities.Reservation.filter({ team_id: data.id, status: "active" }, { limit: 200 })).items || [];
    if (reservations.length) {
      await srp.entities.Reservation.bulkUpdate(reservations.map((r) => ({ id: r.id, status: "cancelled" })));
    }
    await srp.entities.Team.delete(data.id);
    return ok();
  });

export const adminDeleteAllTeams = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const reservations = (await srp.entities.Reservation.filter({ status: "active" }, { limit: 400 })).items || [];
    if (reservations.length) {
      await srp.entities.Reservation.bulkUpdate(reservations.map((r) => ({ id: r.id, status: "cancelled" })));
    }
    const teams = await srp.entities.Team.list("-created_date", 500);
    for (const team of teams) {
      await srp.entities.Team.delete(team.id);
    }
    return ok({ deleted: teams.length });
  });

export const adminListAdmins = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const admins = await srp.entities.Admin.list("-created_date", 200);
    return ok({
      admins: admins.map((a) => ({
        id: a.id,
        username: a.username,
        first_name: a.first_name,
        last_name: a.last_name,
        email: a.email,
      })),
    });
  });

export const adminCreateAdmin = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      username: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      email: z.string(),
      password: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const username = data.username.trim();
    if (!username) return fail("El usuario es obligatorio.");
    if (!EMAIL_RE.test(data.email.trim())) return fail("Escribe un correo válido.");
    if (data.password.length < 6) return fail("La contraseña debe tener al menos 6 caracteres.");

    const admins = await srp.entities.Admin.list("-created_date", 200);
    if (admins.some((a) => (a.username || "").toLowerCase() === username.toLowerCase())) {
      return fail("Ese usuario ya existe.");
    }
    await srp.entities.Admin.create({
      username,
      first_name: data.firstName.trim(),
      last_name: data.lastName.trim(),
      email: data.email.trim().toLowerCase(),
      password_hash: await hashPassword(data.password),
    });
    return ok();
  });

export const adminGetSettings = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const config = await getConfig(srp);
    return ok({
      config: {
        id: config.id,
        registration_enabled: !!config.registration_enabled,
        registration_start: config.registration_start || "",
        registration_end: config.registration_end || "",
        teams_enabled: !!config.teams_enabled,
        teams_start: config.teams_start || "",
        teams_end: config.teams_end || "",
        ip_restriction_enabled: config.ip_restriction_enabled !== false,
        allowed_ips: config.allowed_ips || "",
      },
    });
  });

export const adminUpdateSettings = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      registration_enabled: z.boolean(),
      registration_start: z.string(),
      registration_end: z.string(),
      teams_enabled: z.boolean(),
      teams_start: z.string(),
      teams_end: z.string(),
      ip_restriction_enabled: z.boolean(),
      allowed_ips: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (!(await requireAdmin(srp, data.token))) return fail("Sesión no válida.");
    const ips = data.allowed_ips
      .split(/[,\s]+/)
      .map((ip) => ip.trim())
      .filter(Boolean);
    const invalid = ips.filter((ip) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
    if (invalid.length) return fail(`Estas IP no son válidas: ${invalid.join(", ")}`);

    const config = await getConfig(srp);
    await srp.entities.AppConfig.update(config.id, {
      registration_enabled: data.registration_enabled,
      registration_start: data.registration_start || "",
      registration_end: data.registration_end || "",
      teams_enabled: data.teams_enabled,
      teams_start: data.teams_start || "",
      teams_end: data.teams_end || "",
      ip_restriction_enabled: data.ip_restriction_enabled,
      allowed_ips: ips.join(", "),
    });
    return ok();
  });

export const publicConfig = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().optional() }))
  .handler(async ({ context }) => {
    const srp = serviceRole(context);
    const config = await getConfig(srp);
    return ok({
      registrationEnabled: config.registration_enabled,
      registrationStart: config.registration_start || "",
      registrationEnd: config.registration_end || "",
      subjects: SUBJECTS,
    });
  });