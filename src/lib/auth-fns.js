import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  createToken,
  getConfig,
  hashPassword,
  loadAdmin,
  loadStudent,
  normalizeIp,
  publicAdmin,
  publicStudent,
  readSession,
  readToken,
  registrationOpen,
  requestIp,
  allowedIpList,
  ipRestrictionOn,
  serviceRole,
  verifyPassword,
} from "@/lib/lab-auth.server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

const credentials = z.object({ matricula: z.string(), password: z.string() });

export const registerStudent = createServerFn({ method: "POST" })
  .validator(
    z.object({
      matricula: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      email: z.string(),
      password: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const config = await getConfig(srp);
    if (!registrationOpen(config)) {
      return fail("El registro de estudiantes está cerrado en este momento. Consulta con tu maestro.");
    }
    const matricula = data.matricula.trim();
    if (!/^\d{8}$/.test(matricula)) return fail("La matrícula debe tener exactamente 8 dígitos.");
    if (!data.firstName.trim() || !data.lastName.trim()) return fail("Escribe tu nombre y apellido.");
    if (!EMAIL_RE.test(data.email.trim())) return fail("Escribe un correo válido.");
    if (data.password.length < 6) return fail("La contraseña debe tener al menos 6 caracteres.");

    const existing = await srp.entities.Student.filter({ matricula });
    if (existing.length) return fail("Ya existe una cuenta con esa matrícula.");

    await srp.entities.Student.create({
      matricula,
      first_name: data.firstName.trim(),
      last_name: data.lastName.trim(),
      email: data.email.trim().toLowerCase(),
      password_hash: await hashPassword(data.password),
    });
    return ok();
  });

export const loginStudent = createServerFn({ method: "POST" })
  .validator(credentials)
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const matricula = data.matricula.trim();
    const rows = await srp.entities.Student.filter({ matricula });
    const student = rows[0];
    if (!student) return fail("Matrícula o contraseña incorrecta.");
    if (!(await verifyPassword(data.password, student.password_hash))) {
      return fail("Matrícula o contraseña incorrecta.");
    }

    const config = await getConfig(srp);
    const allowed = allowedIpList(config);
    const ip = normalizeIp(requestIp());
    if (ipRestrictionOn(config) && allowed.length && !allowed.includes(ip)) {
      return fail(
        `Solo puedes iniciar sesión desde las redes del laboratorio (${allowed.join(", ")}). Tu red actual es ${ip || "desconocida"}.`,
      );
    }

    const token = await createToken(srp, { kind: "session", role: "student", userId: student.id });
    return ok({ token, role: "student", user: publicStudent(student) });
  });

export const loginAdmin = createServerFn({ method: "POST" })
  .validator(z.object({ username: z.string(), password: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const value = data.username.trim().toLowerCase();
    const admins = await srp.entities.Admin.list("-created_date", 200);
    const admin = admins.find(
      (a) => (a.username || "").toLowerCase() === value || (a.email || "").toLowerCase() === value,
    );
    if (!admin) return fail("Usuario o contraseña incorrecta.");
    if (!(await verifyPassword(data.password, admin.password_hash))) {
      return fail("Usuario o contraseña incorrecta.");
    }
    const token = await createToken(srp, { kind: "session", role: "admin", userId: admin.id });
    return ok({ token, role: "admin", user: publicAdmin(admin) });
  });

export const sessionInfo = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session) return fail("Sesión expirada.");
    const record = session.role === "admin" ? await loadAdmin(srp, session.user_id) : await loadStudent(srp, session.user_id);
    if (!record) return fail("Sesión expirada.");
    return ok({
      role: session.role,
      user: session.role === "admin" ? publicAdmin(record) : publicStudent(record),
    });
  });

export const logout = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (session) await srp.entities.SessionToken.delete(session.id).catch(() => {});
    return ok();
  });

export const updateStudentProfile = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      email: z.string(),
      currentPassword: z.string().optional(),
      newPassword: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "student") return fail("Sesión no válida.");
    const student = await loadStudent(srp, session.user_id);
    if (!student) return fail("Cuenta no encontrada.");

    const patch = {};
    if (data.email && data.email.trim().toLowerCase() !== student.email) {
      if (!EMAIL_RE.test(data.email.trim())) return fail("Escribe un correo válido.");
      patch.email = data.email.trim().toLowerCase();
    }
    if (data.newPassword) {
      if (data.newPassword.length < 6) return fail("La nueva contraseña debe tener al menos 6 caracteres.");
      if (!data.currentPassword) return fail("Escribe tu contraseña actual.");
      if (!(await verifyPassword(data.currentPassword, student.password_hash))) {
        return fail("Tu contraseña actual no es correcta.");
      }
      patch.password_hash = await hashPassword(data.newPassword);
    }
    if (!Object.keys(patch).length) return fail("No hay cambios por guardar.");
    await srp.entities.Student.update(student.id, patch);
    return ok();
  });

export const updateAdminProfile = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string(),
      username: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      email: z.string(),
      currentPassword: z.string().optional(),
      newPassword: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const session = await readSession(srp, data.token);
    if (!session || session.role !== "admin") return fail("Sesión no válida.");
    const admin = await loadAdmin(srp, session.user_id);
    if (!admin) return fail("Cuenta no encontrada.");

    const username = data.username.trim();
    if (!username) return fail("El usuario no puede quedar vacío.");
    const admins = await srp.entities.Admin.list("-created_date", 200);
    if (admins.some((a) => a.id !== admin.id && (a.username || "").toLowerCase() === username.toLowerCase())) {
      return fail("Ese usuario ya está en uso.");
    }
    if (!EMAIL_RE.test(data.email.trim())) return fail("Escribe un correo válido.");

    const patch = {
      username,
      first_name: data.firstName.trim(),
      last_name: data.lastName.trim(),
      email: data.email.trim().toLowerCase(),
    };
    if (data.newPassword) {
      if (data.newPassword.length < 6) return fail("La nueva contraseña debe tener al menos 6 caracteres.");
      if (!data.currentPassword) return fail("Escribe tu contraseña actual.");
      if (!(await verifyPassword(data.currentPassword, admin.password_hash))) {
        return fail("Tu contraseña actual no es correcta.");
      }
      patch.password_hash = await hashPassword(data.newPassword);
    }
    await srp.entities.Admin.update(admin.id, patch);
    return ok({ user: publicAdmin({ ...admin, ...patch }) });
  });

async function findAccountByEmail(srp, email) {
  const students = await srp.entities.Student.list("-created_date", 500);
  const student = students.find((s) => (s.email || "").toLowerCase() === email);
  if (student) return { role: "student", id: student.id, name: student.first_name };
  const admins = await srp.entities.Admin.list("-created_date", 200);
  const admin = admins.find((a) => (a.email || "").toLowerCase() === email);
  if (admin) return { role: "admin", id: admin.id, name: admin.first_name };
  return null;
}

export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator(z.object({ email: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    const email = data.email.trim().toLowerCase();
    const generic = ok({ message: "Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña." });
    if (!EMAIL_RE.test(email)) return generic;

    const account = await findAccountByEmail(srp, email);
    if (!account) return generic;

    const token = await createToken(srp, { kind: "reset", role: account.role, userId: account.id, minutes: 60 });
    let origin = "";
    try {
      origin = new URL(getRequest().url).origin;
    } catch {
      origin = "";
    }
    const link = `${origin}/restablecer?token=${token}`;
    try {
      await context.getBase44().asServiceRole.integrations.Core.SendEmail({
        to: email,
        subject: "Restablecer contraseña · Laboratorio",
        body: `Hola ${account.name}, para restablecer tu contraseña entra a: ${link}\n\nEl enlace vence en 60 minutos.`,
        html: `<p>Hola ${account.name},</p><p>Para restablecer tu contraseña entra a este enlace:</p><p><a href="${link}">${link}</a></p><p>El enlace vence en 60 minutos. Si no solicitaste el cambio, ignora este correo.</p>`,
      });
    } catch {
      // No revelamos si el envío falló ni si la cuenta existe.
    }
    return generic;
  });

export const resetPassword = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string(), password: z.string() }))
  .handler(async ({ data, context }) => {
    const srp = serviceRole(context);
    if (data.password.length < 6) return fail("La contraseña debe tener al menos 6 caracteres.");
    const record = await readToken(srp, data.token, "reset");
    if (!record) return fail("El enlace no es válido o ya venció. Solicita uno nuevo.");
    const entity = record.role === "admin" ? srp.entities.Admin : srp.entities.Student;
    await entity.update(record.user_id, { password_hash: await hashPassword(data.password) });
    await srp.entities.SessionToken.delete(record.id).catch(() => {});
    return ok();
  });