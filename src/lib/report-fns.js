import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { BLOCKS } from "@/lib/lab-constants";
import { readSession, serviceRole } from "@/lib/lab-auth.server";

const STATUS_LABELS = {
  active: "Activa",
  cancelled: "Cancelada",
  no_show: "No asistió",
  attended: "Asistió",
};

const fail = (error) => ({ ok: false, error });

export const adminReservationsReport = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
      activeOnly: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (session?.role !== "admin") return fail("Sesión no válida.");

    const query = {};
    if (data.activeOnly) query.status = "active";
    if (data.from && data.to) query.reservation_date = { $gte: data.from, $lte: data.to };

    const raw = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await srp.entities.Reservation.filter(query, {
        sort: "reservation_date",
        limit: 500,
        cursor,
      });
      raw.push(...(result.items || []));
      if (!result.has_more) break;
      cursor = result.next_cursor;
    }

    const teams = await srp.entities.Team.list("-created_date", 1000);
    const teamMap = new Map(teams.map((team) => [team.id, team]));

    const items = raw
      .map((r) => {
        const team = teamMap.get(r.team_id);
        return {
          date: r.reservation_date,
          block_index: r.block,
          block: BLOCKS[r.block]?.label || `Bloque ${r.block}`,
          subject: r.subject,
          practice: r.practice,
          plc: r.plc || "",
          mps: r.mps || "",
          team: team?.has_number && team.team_number ? `Equipo ${team.team_number}` : "Equipo sin número",
          members: (team?.members || []).join(", "),
          booker: r.booker_name || "",
          matricula: r.booker_matricula || "",
          status: STATUS_LABELS[r.status] || r.status,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.block_index - b.block_index);

    return { ok: true, items };
  });