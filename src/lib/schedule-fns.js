import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  BLOCKS,
  CAPACITY,
  MPS_OPTIONS,
  PLC_OPTIONS,
  PRACTICES,
  SANCTION_GRACE_MIN,
  SANCTION_WINDOW_MIN,
  REVERT_WINDOW_MIN,
  TOTAL_DAY_CAPACITY,
  addDays,
  blockStartMinutes,
  minutesInTz,
  needsMps,
  needsPlc,
  todayInTz,
  weekMondayOf,
} from "@/lib/lab-constants";
import {
  bookableDates,
  getConfig,
  loadStudent,
  readSession,
  sanctionEndDate,
  serviceRole,
} from "@/lib/lab-auth.server";

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

async function activeReservations(srp) {
  const page = await srp.entities.Reservation.filter({ status: "active" }, { limit: 400 });
  return page.items || [];
}

function slotKey(date, block) {
  return `${date}#${block}`;
}

export const getSchedule = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), weekStart: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session) return fail("Sesión expirada.");

    const today = todayInTz();
    const nowMinutes = minutesInTz();
    const config = await getConfig(srp);
    const monday = weekMondayOf(/^\d{4}-\d{2}-\d{2}$/.test(data.weekStart) ? data.weekStart : today);
    const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));

    let active = await activeReservations(srp);

    // Cierra los horarios ya pasados o cuyo margen de tolerancia terminó.
    const stale = active.filter(
      (r) =>
        r.reservation_date < today ||
        (r.reservation_date === today && nowMinutes > blockStartMinutes(r.block) + SANCTION_WINDOW_MIN),
    );
    if (stale.length) {
      await srp.entities.Reservation.bulkUpdate(stale.map((r) => ({ id: r.id, status: "attended" })));
      const staleIds = new Set(stale.map((r) => r.id));
      active = active.filter((r) => !staleIds.has(r.id));
    }

    const teams = await srp.entities.Team.list("-created_date", 500);
    const teamMap = new Map(teams.map((t) => [t.id, t]));

    const reservations = active
      .filter((r) => days.includes(r.reservation_date))
      .map((r) => {
        const team = teamMap.get(r.team_id);
        return {
          id: r.id,
          date: r.reservation_date,
          block: r.block,
          subject: r.subject,
          practice: r.practice,
          plc: r.plc || "",
          mps: r.mps || "",
          team_id: r.team_id,
          team_number: team?.team_number || "",
          has_number: !!team?.has_number,
          team_members: team?.members || [],
          sanctioned_until: team?.sanctioned_until || "",
          booker_name: r.booker_name || "",
          booker_matricula: r.booker_matricula || "",
          sanctioned_at: r.sanctioned_at || "",
          created_today: todayInTz(new Date(r.created_date)) === today,
        };
      });

    const dayCounts = {};
    active.forEach((r) => {
      dayCounts[r.reservation_date] = (dayCounts[r.reservation_date] || 0) + 1;
    });

    let student = null;
    let myTeams = [];
    let bookable = [];
    if (session.role === "student") {
      student = await loadStudent(srp, session.user_id);
      if (student) {
        myTeams = teams
          .filter((t) => (t.members || []).includes(student.matricula))
          .map((t) => ({
            id: t.id,
            subject: t.subject,
            team_number: t.team_number || "",
            has_number: !!t.has_number,
            members: t.members || [],
            sanctioned_until: t.sanctioned_until || "",
            sanctioned: !!t.sanctioned_until && today <= t.sanctioned_until,
          }));
      }
      bookable = bookableDates(today, (d) => (dayCounts[d] || 0) >= TOTAL_DAY_CAPACITY);
    }

    return ok({
      role: session.role,
      today,
      nowMinutes,
      days,
      monday,
      reservations,
      bookable,
      myTeams,
      student: student ? { matricula: student.matricula, first_name: student.first_name, last_name: student.last_name } : null,
      capacity: CAPACITY,
      totalCapacity: TOTAL_DAY_CAPACITY,
      teamsWindowOpen: !!config.teams_enabled,
    });
  });

export const acquireSlot = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), date: z.string(), block: z.number() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "student") return fail("Sesión no válida.");
    const student = await loadStudent(srp, session.user_id);
    if (!student) return fail("Cuenta no encontrada.");

    const key = slotKey(data.date, data.block);
    const locks = (await srp.entities.SlotLock.filter({ slot_key: key }, { limit: 20 })).items || [];
    const now = Date.now();
    const live = locks.filter((l) => new Date(l.expires_at).getTime() > now);

    for (const lock of locks.filter((l) => new Date(l.expires_at).getTime() <= now)) {
      await srp.entities.SlotLock.delete(lock.id).catch(() => {});
    }

    const mine = live.find((l) => l.holder_token === session.user_id);
    if (mine) {
      await srp.entities.SlotLock.update(mine.id, {
        expires_at: new Date(now + 5 * 60000).toISOString(),
      });
      return ok({ lockToken: session.user_id });
    }
    if (live.length) {
      const holder = live[0].holder_name ? ` (${live[0].holder_name})` : "";
      return fail(`Alguien más${holder} está apartando este horario. Espera a que termine o elige otro horario.`);
    }

    await srp.entities.SlotLock.create({
      slot_key: key,
      holder_token: session.user_id,
      holder_name: `${student.first_name} ${student.last_name}`,
      expires_at: new Date(now + 5 * 60000).toISOString(),
    });
    return ok({ lockToken: session.user_id });
  });

export const releaseSlot = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), date: z.string(), block: z.number() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session) return ok();
    const key = slotKey(data.date, data.block);
    const locks = (await srp.entities.SlotLock.filter({ slot_key: key }, { limit: 20 })).items || [];
    for (const lock of locks.filter((l) => l.holder_token === session.user_id)) {
      await srp.entities.SlotLock.delete(lock.id).catch(() => {});
    }
    return ok();
  });

export const createReservation = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      date: z.string(),
      block: z.number(),
      subject: z.string(),
      practice: z.string(),
      plc: z.string().optional(),
      mps: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "student") return fail("Sesión no válida.");
    const student = await loadStudent(srp, session.user_id);
    if (!student) return fail("Cuenta no encontrada.");

    const today = todayInTz();
    const active = await activeReservations(srp);

    const dayCounts = {};
    active.forEach((r) => {
      dayCounts[r.reservation_date] = (dayCounts[r.reservation_date] || 0) + 1;
    });
    const allowed = bookableDates(today, (d) => (dayCounts[d] || 0) >= TOTAL_DAY_CAPACITY);
    if (!allowed.includes(data.date)) {
      return fail("Ese día no está disponible para apartar. Solo puedes apartar con un día de anticipación.");
    }

    const teams = await srp.entities.Team.list("-created_date", 500);
    const myTeams = teams.filter((t) => (t.members || []).includes(student.matricula));
    const team = myTeams.find((t) => t.subject === data.subject);
    if (!team) return fail(`No tienes un equipo registrado en ${data.subject}.`);
    if (team.sanctioned_until && today <= team.sanctioned_until) {
      return fail(`Tu equipo está sancionado en ${data.subject} hasta el ${team.sanctioned_until}.`);
    }

    const already = active.find((r) => r.team_id === team.id && r.reservation_date === data.date);
    if (already) return fail("Tu equipo ya tiene un horario apartado de esta materia ese día.");

    const validPractices = PRACTICES[data.subject] || [];
    if (!validPractices.includes(data.practice)) return fail("Esa práctica no pertenece a la materia elegida.");

    const plc = needsPlc(data.practice) ? (data.plc || "").trim() : "";
    const mps = needsMps(data.practice) ? (data.mps || "").trim() : "";
    if (needsPlc(data.practice) && !PLC_OPTIONS.includes(plc)) return fail("Selecciona el PLC que van a utilizar.");
    if (needsMps(data.practice) && !MPS_OPTIONS.includes(mps)) return fail("Selecciona la MPS que van a utilizar.");

    const slot = active.filter(
      (r) => r.reservation_date === data.date && r.block === data.block && r.subject === data.subject,
    );
    const samePractice = slot.filter((r) => r.practice === data.practice);
    const limit = CAPACITY[data.subject]?.[data.practice] ?? 1;
    if (samePractice.length >= limit) {
      return fail(`Ya no hay cupo para ${data.practice} de ${data.subject} en ese horario.`);
    }
    if (data.practice === "PLC" && samePractice.some((r) => r.plc === plc)) {
      return fail(`El ${plc} ya está ocupado en ese horario por otro equipo.`);
    }
    if (data.practice === "MPS" && samePractice.some((r) => r.plc === plc && r.mps === mps)) {
      return fail(`La ${mps} con ${plc} ya está ocupada en ese horario por otro equipo.`);
    }

    await srp.entities.Reservation.create({
      reservation_date: data.date,
      block: data.block,
      subject: data.subject,
      practice: data.practice,
      plc,
      mps,
      team_id: team.id,
      booker_matricula: student.matricula,
      booker_name: `${student.first_name} ${student.last_name}`,
      status: "active",
    });

    const locks = (await srp.entities.SlotLock.filter({ slot_key: slotKey(data.date, data.block) }, { limit: 20 })).items || [];
    for (const lock of locks.filter((l) => l.holder_token === session.user_id)) {
      await srp.entities.SlotLock.delete(lock.id).catch(() => {});
    }
    return ok();
  });

export const cancelReservation = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), id: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "student") return fail("Sesión no válida.");
    const student = await loadStudent(srp, session.user_id);
    const reservation = await srp.entities.Reservation.get(data.id).catch(() => null);
    if (!reservation || reservation.status !== "active") return fail("Ese apartado ya no está activo.");
    if (todayInTz(new Date(reservation.created_date)) !== todayInTz()) {
      return fail("Solo puedes cancelar el mismo día en que apartaste.");
    }
    const teams = await srp.entities.Team.list("-created_date", 500);
    const team = teams.find((t) => t.id === reservation.team_id);
    if (!team || !(team.members || []).includes(student?.matricula)) return fail("No puedes cancelar este apartado.");
    await srp.entities.Reservation.update(data.id, { status: "cancelled" });
    return ok();
  });

export const adminDeleteReservation = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), id: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "admin") return fail("Sesión no válida.");
    const reservation = await srp.entities.Reservation.get(data.id).catch(() => null);
    if (!reservation) return fail("El apartado ya no existe.");
    const today = todayInTz();
    if (reservation.reservation_date > addDays(today, 1)) {
      return fail("Solo puedes eliminar apartados del mismo día o de un día antes.");
    }
    await srp.entities.Reservation.update(data.id, { status: "cancelled" });
    return ok();
  });

export const sanctionReservation = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), id: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "admin") return fail("Sesión no válida.");
    const reservation = await srp.entities.Reservation.get(data.id).catch(() => null);
    if (!reservation || reservation.status !== "active") return fail("El apartado ya no está activo.");

    const today = todayInTz();
    const now = minutesInTz();
    if (reservation.reservation_date !== today) return fail("Solo puedes sancionar el mismo día del apartado.");
    const start = blockStartMinutes(reservation.block);
    if (now < start + SANCTION_GRACE_MIN) return fail("Todavía están dentro del margen de tolerancia.");
    if (now > start + SANCTION_WINDOW_MIN) return fail("La ventana para sancionar ya terminó.");

    const until = sanctionEndDate(reservation.reservation_date);
    await srp.entities.Reservation.update(data.id, {
      status: "no_show",
      sanctioned_at: new Date().toISOString(),
    });
    await srp.entities.Team.update(reservation.team_id, { sanctioned_until: until, sanction_reason: reservation.subject });
    return ok({ until });
  });

export const revertSanction = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), id: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "admin") return fail("Sesión no válida.");
    const reservation = await srp.entities.Reservation.get(data.id).catch(() => null);
    if (!reservation || reservation.status !== "no_show" || !reservation.sanctioned_at) {
      return fail("Esa sanción ya no se puede revertir.");
    }
    const elapsed = (Date.now() - new Date(reservation.sanctioned_at).getTime()) / 60000;
    if (elapsed > REVERT_WINDOW_MIN) return fail("El tiempo para revertir la sanción ya pasó.");

    await srp.entities.Reservation.update(data.id, { status: "active", sanctioned_at: "" });
    await srp.entities.Team.update(reservation.team_id, { sanctioned_until: "", sanction_reason: "" });
    return ok();
  });