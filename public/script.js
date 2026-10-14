const state = { token: localStorage.getItem("trionixToken"), tickets: [], agents: [] };
const $ = selector => document.querySelector(selector);

function showMessage(element, text, error = false) {
    element.textContent = text;
    element.className = `message ${error ? "error" : "success"}`;
}

async function api(url, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) logout();
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "No se pudo completar la operación");
    return body;
}

function setLoggedIn(agent) {
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    $("#logoutButton").classList.remove("hidden");
    document.title = `Trionix Tickets | ${agent.nombre}`;
}

function logout() {
    state.token = null;
    localStorage.removeItem("trionixToken");
    $("#appView").classList.add("hidden");
    $("#logoutButton").classList.add("hidden");
    $("#loginView").classList.remove("hidden");
}

function addText(parent, tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    parent.appendChild(element);
    return element;
}

function renderTickets() {
    const list = $("#ticketList");
    list.replaceChildren();
    const priority = $("#filterPriority").value;
    const status = $("#filterStatus").value;
    const tickets = state.tickets.filter(ticket => (!priority || ticket.prioridad === priority) && (!status || ticket.estado === status));
    if (!tickets.length) return addText(list, "p", "No hay tickets para este filtro.", "empty");
    tickets.forEach(ticket => {
        const card = document.createElement("article");
        card.className = `ticket-card priority-${ticket.prioridad}`;
        addText(card, "h3", ticket.asunto);
        addText(card, "p", `Cliente: ${ticket.cliente}`);
        addText(card, "span", ticket.prioridad.toUpperCase(), "badge");
        addText(card, "span", ticket.estado, "status");
        addText(card, "p", ticket.agenteAsignado ? `Agente: ${ticket.agenteAsignado.nombre}` : "Sin agente asignado", "assigned");
        const actions = document.createElement("div"); actions.className = "actions";
        if (ticket.estado === "abierto") {
            const resolve = document.createElement("button"); resolve.className = "button small"; resolve.textContent = "Marcar resuelto";
            resolve.onclick = async () => { try { await api(`/api/tickets/${ticket._id}`, { method: "PATCH", body: JSON.stringify({ estado: "resuelto" }) }); await loadTickets(); } catch (e) { alert(e.message); } };
            actions.appendChild(resolve);
        }
        const select = document.createElement("select"); select.innerHTML = '<option value="">Asignar agente</option>';
        state.agents.filter(agent => agent.activo).forEach(agent => { const option = new Option(agent.nombre, agent._id, false, ticket.agenteAsignado?._id === agent._id); select.appendChild(option); });
        select.onchange = async () => { if (!select.value) return; try { await api(`/api/tickets/${ticket._id}/asignar`, { method: "POST", body: JSON.stringify({ agenteId: select.value }) }); await loadTickets(); } catch (e) { alert(e.message); } };
        actions.appendChild(select);
        const commentInput = document.createElement("input"); commentInput.placeholder = "Agregar comentario";
        const commentButton = document.createElement("button"); commentButton.className = "button small secondary"; commentButton.textContent = "Comentar";
        commentButton.onclick = async () => { if (!commentInput.value.trim()) return; try { await api(`/api/tickets/${ticket._id}/comments`, { method: "POST", body: JSON.stringify({ texto: commentInput.value }) }); commentInput.value = ""; await loadTickets(); } catch (e) { alert(e.message); } };
        actions.append(commentInput, commentButton);
        const remove = document.createElement("button"); remove.className = "button small danger"; remove.textContent = "Eliminar";
        remove.onclick = async () => { if (!confirm("¿Eliminar este ticket?")) return; try { await api(`/api/tickets/${ticket._id}`, { method: "DELETE" }); await loadTickets(); } catch (e) { alert(e.message); } };
        actions.appendChild(remove); card.appendChild(actions);
        if (ticket.comentarios.length) { const comments = document.createElement("div"); comments.className = "comments"; ticket.comentarios.forEach(comment => addText(comments, "p", `${comment.autor?.nombre || "Agente"}: ${comment.texto}`)); card.appendChild(comments); }
        list.appendChild(card);
    });
}

function renderAgents() {
    const list = $("#agentList"); list.replaceChildren();
    state.agents.forEach(agent => { const row = document.createElement("div"); row.className = `agent-row ${agent.activo ? "" : "inactive"}`; addText(row, "strong", agent.nombre); addText(row, "span", `${agent.email} · ${agent.especialidad}`); const button = document.createElement("button"); button.className = "button small danger"; button.textContent = agent.activo ? "Desactivar" : "Inactivo"; button.disabled = !agent.activo; button.onclick = async () => { if (!confirm("¿Desactivar este agente?")) return; try { await api(`/api/agents/${agent._id}`, { method: "DELETE" }); await loadAgents(); } catch (e) { alert(e.message); } }; row.appendChild(button); list.appendChild(row); });
}

async function loadTickets() {
    const params = new URLSearchParams();
    const status = $("#filterStatus").value;
    const priority = $("#filterPriority").value;
    if (status) params.set("estado", status);
    if (priority) params.set("prioridad", priority);
    const query = params.toString();
    state.tickets = await api(`/api/tickets${query ? `?${query}` : ""}`);
    renderTickets();
}
async function loadAgents() { state.agents = await api("/api/agents"); renderAgents(); renderTickets(); }

$("#loginForm").addEventListener("submit", async event => { event.preventDefault(); try { const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: $("#loginEmail").value, password: $("#loginPassword").value }) }); state.token = result.token; localStorage.setItem("trionixToken", state.token); setLoggedIn(result.agent); await Promise.all([loadTickets(), loadAgents()]); } catch (e) { showMessage($("#loginMessage"), e.message, true); } });
$("#ticketForm").addEventListener("submit", async event => { event.preventDefault(); try { await api("/api/tickets", { method: "POST", body: JSON.stringify({ cliente: $("#cliente").value, asunto: $("#asunto").value, prioridad: $("#prioridad").value }) }); event.target.reset(); showMessage($("#ticketMessage"), "Ticket creado correctamente"); await loadTickets(); } catch (e) { showMessage($("#ticketMessage"), e.message, true); } });
$("#agentForm").addEventListener("submit", async event => { event.preventDefault(); try { await api("/api/agents", { method: "POST", body: JSON.stringify({ nombre: $("#agentName").value, email: $("#agentEmail").value, especialidad: $("#agentSpecialty").value, password: $("#agentPassword").value }) }); event.target.reset(); showMessage($("#agentMessage"), "Agente creado correctamente"); await loadAgents(); } catch (e) { showMessage($("#agentMessage"), e.message, true); } });
$("#filterPriority").addEventListener("change", loadTickets); $("#filterStatus").addEventListener("change", loadTickets); $("#refreshButton").addEventListener("click", () => Promise.all([loadTickets(), loadAgents()])); $("#logoutButton").addEventListener("click", logout);

if (state.token) api("/api/auth/me").then(result => { setLoggedIn(result.agent); return Promise.all([loadTickets(), loadAgents()]); }).catch(logout);
