require("dotenv").config();

const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "desarrollo-inseguro-cambiar-en-produccion";

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).messages({
    "string.pattern.base": "El identificador no es válido"
});

const agentSchema = new mongoose.Schema({
    nombre: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    especialidad: { type: String, required: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },
    activo: { type: Boolean, default: true }
}, { timestamps: true });

const commentSchema = new mongoose.Schema({
    texto: { type: String, required: true, trim: true, maxlength: 1000 },
    autor: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", required: true }
}, { timestamps: true });

const ticketSchema = new mongoose.Schema({
    cliente: { type: String, required: true, trim: true, maxlength: 120 },
    asunto: { type: String, required: true, trim: true, minlength: 5, maxlength: 200 },
    prioridad: { type: String, enum: ["baja", "media", "alta"], required: true },
    estado: { type: String, enum: ["abierto", "resuelto"], default: "abierto" },
    agenteAsignado: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", default: null },
    comentarios: { type: [commentSchema], default: [] }
}, { timestamps: true });

ticketSchema.index({ estado: 1, prioridad: 1, createdAt: -1 });
ticketSchema.index({ agenteAsignado: 1 });

const Agent = mongoose.model("Agent", agentSchema);
const Ticket = mongoose.model("Ticket", ticketSchema);

const schemas = {
    login: Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().min(6).required()
    }),
    agent: Joi.object({
        nombre: Joi.string().trim().min(2).max(80).required(),
        email: Joi.string().trim().email().required(),
        especialidad: Joi.string().trim().max(120).required(),
        password: Joi.string().min(6).max(100).required(),
        activo: Joi.boolean().default(true)
    }).unknown(false),
    agentUpdate: Joi.object({
        nombre: Joi.string().trim().min(2).max(80),
        email: Joi.string().trim().email(),
        especialidad: Joi.string().trim().max(120),
        password: Joi.string().min(6).max(100),
        activo: Joi.boolean()
    }).min(1).unknown(false),
    ticket: Joi.object({
        cliente: Joi.string().trim().max(120).required(),
        asunto: Joi.string().trim().min(5).max(200).required(),
        prioridad: Joi.string().valid("baja", "media", "alta").required()
    }).unknown(false),
    ticketUpdate: Joi.object({
        cliente: Joi.string().trim().max(120),
        asunto: Joi.string().trim().min(5).max(200),
        prioridad: Joi.string().valid("baja", "media", "alta"),
        estado: Joi.string().valid("abierto", "resuelto")
    }).min(1).unknown(false),
    comment: Joi.object({ texto: Joi.string().trim().min(1).max(1000).required() }).unknown(false),
    id: Joi.object({ id: objectId.required() }),
    filters: Joi.object({
        estado: Joi.string().valid("abierto", "resuelto").empty(""),
        prioridad: Joi.string().valid("baja", "media", "alta").empty(""),
        agenteAsignado: objectId.empty("")
    })
};

function validate(schema, value) {
    const result = schema.validate(value, { abortEarly: false, stripUnknown: false });
    if (result.error) {
        const error = new Error(result.error.details.map(detail => detail.message).join(". "));
        error.status = 400;
        throw error;
    }
    return result.value;
}

function publicAgent(agent) {
    const value = agent.toObject ? agent.toObject() : { ...agent };
    delete value.passwordHash;
    return value;
}

function signToken(agent) {
    return jwt.sign({ sub: agent._id.toString(), email: agent.email }, JWT_SECRET, { expiresIn: "8h" });
}

async function requireAuth(req, res, next) {
    try {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;
        if (!token) return res.status(401).json({ error: "Debes iniciar sesión" });
        const payload = jwt.verify(token, JWT_SECRET);
        const agent = await Agent.findOne({ _id: payload.sub, activo: true });
        if (!agent) return res.status(401).json({ error: "La sesión no es válida" });
        req.agent = agent;
        next();
    } catch (error) {
        res.status(401).json({ error: "La sesión no es válida o ha expirado" });
    }
}

function handleAsync(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function populateTicket(ticket) {
    return Ticket.populate(ticket, [
        { path: "agenteAsignado", select: "nombre email especialidad activo" },
        { path: "comentarios.autor", select: "nombre email especialidad activo" }
    ]);
}

app.get("/health", (req, res) => res.json({ status: "ok", database: mongoose.connection.readyState === 1 }));

app.post("/api/auth/login", handleAsync(async (req, res) => {
    const data = validate(schemas.login, req.body);
    const agent = await Agent.findOne({ email: data.email.toLowerCase(), activo: true }).select("+passwordHash");
    if (!agent || !(await bcrypt.compare(data.password, agent.passwordHash))) {
        return res.status(401).json({ error: "Correo o contraseña incorrectos" });
    }
    res.json({ token: signToken(agent), agent: publicAgent(agent) });
}));

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ agent: publicAgent(req.agent) }));

// Permite crear el primer agente sin sesión; los siguientes requieren autenticación.
app.post("/api/agents", handleAsync(async (req, res, next) => {
    if (await Agent.exists({})) {
        return requireAuth(req, res, () => createAgent(req, res, next));
    }
    return createAgent(req, res, next);
}));

async function createAgent(req, res) {
    const data = validate(schemas.agent, req.body);
    const agent = await Agent.create({
        nombre: data.nombre,
        email: data.email,
        especialidad: data.especialidad,
        passwordHash: await bcrypt.hash(data.password, 12),
        activo: data.activo
    });
    res.status(201).json(publicAgent(agent));
}

app.get("/api/agents", requireAuth, handleAsync(async (req, res) => {
    const agents = await Agent.find().sort({ activo: -1, nombre: 1 });
    res.json(agents.map(publicAgent));
}));

app.get("/api/agents/:id", requireAuth, handleAsync(async (req, res) => {
    const { id } = validate(schemas.id, req.params);
    const agent = await Agent.findById(id);
    if (!agent) return res.status(404).json({ error: "Agente no encontrado" });
    res.json(publicAgent(agent));
}));

app.patch("/api/agents/:id", requireAuth, handleAsync(async (req, res) => {
    const { id } = validate(schemas.id, req.params);
    const data = validate(schemas.agentUpdate, req.body);
    const changes = { ...data };
    if (changes.password) {
        changes.passwordHash = await bcrypt.hash(changes.password, 12);
        delete changes.password;
    }
    const agent = await Agent.findByIdAndUpdate(id, changes, { new: true, runValidators: true });
    if (!agent) return res.status(404).json({ error: "Agente no encontrado" });
    res.json(publicAgent(agent));
}));

// Borrado lógico: conserva las referencias históricas de los tickets.
app.delete("/api/agents/:id", requireAuth, handleAsync(async (req, res) => {
    const { id } = validate(schemas.id, req.params);
    const agent = await Agent.findByIdAndUpdate(id, { activo: false }, { new: true });
    if (!agent) return res.status(404).json({ error: "Agente no encontrado" });
    res.json({ mensaje: "Agente desactivado", agent: publicAgent(agent) });
}));

app.get("/api/tickets", requireAuth, handleAsync(async (req, res) => {
    const filters = validate(schemas.filters, req.query);
    const tickets = await Ticket.find(filters).sort({ createdAt: -1 });
    await Ticket.populate(tickets, [
        { path: "agenteAsignado", select: "nombre email especialidad activo" },
        { path: "comentarios.autor", select: "nombre email especialidad activo" }
    ]);
    res.json(tickets);
}));

app.get("/api/tickets/:id", requireAuth, handleAsync(async (req, res) => {
    const { id } = validate(schemas.id, req.params);
    const ticket = await Ticket.findById(id).populate([
        { path: "agenteAsignado", select: "nombre email especialidad activo" },
        { path: "comentarios.autor", select: "nombre email especialidad activo" }
    ]);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    res.json(ticket);
}));

app.post("/api/tickets", requireAuth, handleAsync(async (req, res) => {
    const data = validate(schemas.ticket, req.body);
    const ticket = await Ticket.create(data);
    res.status(201).json(await populateTicket(ticket));
}));

async function updateTicket(req, res) {
    const { id } = validate(schemas.id, req.params);
    const data = validate(schemas.ticketUpdate, req.body);
    const ticket = await Ticket.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    res.json(await populateTicket(ticket));
}

app.patch("/api/tickets/:id", requireAuth, handleAsync(updateTicket));
app.put("/api/tickets/:id", requireAuth, handleAsync(updateTicket));

app.post("/api/tickets/:id/asignar", requireAuth, handleAsync(async (req, res) => {
    const { id } = validate(schemas.id, req.params);
    const data = validate(Joi.object({ agenteId: objectId.required() }).unknown(false), req.body);
    const agent = await Agent.findOne({ _id: data.agenteId, activo: true });
    if (!agent) return res.status(404).json({ error: "El agente no existe o está inactivo" });
    const ticket = await Ticket.findByIdAndUpdate(id, { agenteAsignado: agent._id }, { new: true });
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    res.json(await populateTicket(ticket));
}));

app.delete("/api/tickets/:id", requireAuth, handleAsync(async (req, res) => {
    const { id } = validate(schemas.id, req.params);
    const ticket = await Ticket.findByIdAndDelete(id);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    res.status(204).send();
}));

app.post("/api/tickets/:id/comments", requireAuth, handleAsync(async (req, res) => {
    const { id } = validate(schemas.id, req.params);
    const { texto } = validate(schemas.comment, req.body);
    const ticket = await Ticket.findById(id);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    ticket.comentarios.push({ texto, autor: req.agent._id });
    await ticket.save();
    res.status(201).json(await populateTicket(ticket));
}));

app.patch("/api/tickets/:id/comments/:commentId", requireAuth, handleAsync(async (req, res) => {
    const { id, commentId } = validate(Joi.object({ id: objectId.required(), commentId: objectId.required() }), req.params);
    const { texto } = validate(schemas.comment, req.body);
    const ticket = await Ticket.findById(id);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const comment = ticket.comentarios.id(commentId);
    if (!comment) return res.status(404).json({ error: "Comentario no encontrado" });
    comment.texto = texto;
    await ticket.save();
    res.json(await populateTicket(ticket));
}));

app.delete("/api/tickets/:id/comments/:commentId", requireAuth, handleAsync(async (req, res) => {
    const { id, commentId } = validate(Joi.object({ id: objectId.required(), commentId: objectId.required() }), req.params);
    const ticket = await Ticket.findById(id);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const comment = ticket.comentarios.id(commentId);
    if (!comment) return res.status(404).json({ error: "Comentario no encontrado" });
    comment.deleteOne();
    await ticket.save();
    res.status(204).send();
}));

app.use((error, req, res, next) => {
    if (error.code === 11000) return res.status(409).json({ error: "Ya existe un agente con ese correo" });
    if (error.name === "CastError") return res.status(400).json({ error: "Identificador no válido" });
    const status = error.status || 500;
    res.status(status).json({ error: status === 500 ? "Error interno del servidor" : error.message });
});

async function start() {
    if (!process.env.MONGODB_URI) {
        throw new Error("Falta configurar MONGODB_URI en el archivo .env");
    }
    await mongoose.connect(process.env.MONGODB_URI);
    app.listen(PORT, () => console.log(`Servidor funcionando en el puerto ${PORT}`));
}

if (require.main === module) {
    start().catch(error => {
        console.error("No se pudo iniciar la aplicación:", error.message);
        process.exit(1);
    });
}

module.exports = app;
