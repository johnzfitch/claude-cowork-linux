#!/usr/bin/env python3
"""A stand-in for xdg-desktop-portal's GlobalShortcuts interface, for tests.

It reproduces the rules of the real frontend (desktop-portal/xdp-session.c,
xdp-request.c and global-shortcuts.c in flatpak/xdg-desktop-portal) that
decide whether a client works at all:

  * a session belongs to the D-Bus connection that created it, and is closed
    when that connection disconnects;
  * Request::Response and GlobalShortcuts::Activated are unicast to the
    owning connection, never broadcast;
  * BindShortcuts / Session.Close from any other connection is refused with
    "Invalid session".

It also exposes org.example.FakePortal on /test so a test can read the state
(State() -> JSON) and press a bound shortcut (Fire(id)).

Run on a private session bus:  dbus-run-session -- python3 fake_global_shortcuts_portal.py
Prints READY on stdout once the name is owned.
"""

import json
import sys

from gi.repository import Gio, GLib

BUS_NAME = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"

XML = """
<node>
  <interface name="org.freedesktop.portal.GlobalShortcuts">
    <method name="CreateSession">
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <method name="BindShortcuts">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a(sa{sv})" name="shortcuts" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="request_handle" direction="out"/>
    </method>
    <property name="version" type="u" access="read"/>
  </interface>
</node>
"""
SESSION_XML = """
<node>
  <interface name="org.freedesktop.portal.Session">
    <method name="Close"/>
  </interface>
</node>
"""
TEST_XML = """
<node>
  <interface name="org.example.FakePortal">
    <method name="State"><arg type="s" name="json" direction="out"/></method>
    <method name="Fire"><arg type="s" name="shortcut_id" direction="in"/></method>
  </interface>
</node>
"""

node = Gio.DBusNodeInfo.new_for_xml(XML)
session_node = Gio.DBusNodeInfo.new_for_xml(SESSION_XML)
test_node = Gio.DBusNodeInfo.new_for_xml(TEST_XML)

# session path -> {"owner": sender, "bound": [ids], "reg": registration id}
sessions = {}
closed = []
counter = [0]


def escape(sender):
    return sender[1:].replace(".", "_")


def close_session(conn, path, reason):
    s = sessions.pop(path, None)
    if s is None:
        return
    conn.unregister_object(s["reg"])
    closed.append({"path": path, "reason": reason, "bound": s["bound"]})


def respond(conn, sender, request_path, results):
    # Unicast, exactly like xdp_request_on_signal_response.
    GLib.idle_add(lambda: conn.emit_signal(
        sender, request_path, "org.freedesktop.portal.Request", "Response",
        GLib.Variant("(ua{sv})", (0, results))) and False)


def on_session_call(conn, sender, path, iface, method, params, inv):
    s = sessions.get(path)
    if s is None or s["owner"] != sender:
        inv.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "Invalid session")
        return
    close_session(conn, path, "Close")
    inv.return_value(None)


def on_portal_call(conn, sender, path, iface, method, params, inv):
    if method == "CreateSession":
        opts = params.unpack()[0]
        counter[0] += 1
        token = opts.get("handle_token", "t%d" % counter[0])
        stoken = opts.get("session_handle_token", "s%d" % counter[0])
        req = "%s/request/%s/%s" % (PORTAL_PATH, escape(sender), token)
        spath = "%s/session/%s/%s" % (PORTAL_PATH, escape(sender), stoken)
        if spath in sessions:
            inv.return_dbus_error("org.freedesktop.DBus.Error.InvalidArgs", "session token in use")
            return
        reg = conn.register_object(spath, session_node.interfaces[0], on_session_call, None, None)
        sessions[spath] = {"owner": sender, "bound": [], "reg": reg}
        inv.return_value(GLib.Variant("(o)", (req,)))
        respond(conn, sender, req, {"session_handle": GLib.Variant("s", spath)})
    elif method == "BindShortcuts":
        spath, shortcuts, _parent, opts = params.unpack()
        s = sessions.get(spath)
        if s is None or s["owner"] != sender:
            inv.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "Invalid session")
            return
        s["bound"] = [sid for sid, _props in shortcuts]
        counter[0] += 1
        req = "%s/request/%s/%s" % (PORTAL_PATH, escape(sender), opts.get("handle_token", "b%d" % counter[0]))
        inv.return_value(GLib.Variant("(o)", (req,)))
        respond(conn, sender, req, {"shortcuts": params.get_child_value(1)})


def on_portal_get(conn, sender, path, iface, prop):
    return GLib.Variant("u", 1)


def on_test_call(conn, sender, path, iface, method, params, inv):
    if method == "State":
        inv.return_value(GLib.Variant("(s)", (json.dumps({
            "sessions": {p: {"owner": s["owner"], "bound": s["bound"]} for p, s in sessions.items()},
            "closed": closed,
        }),)))
    elif method == "Fire":
        sid = params.unpack()[0]
        for p, s in sessions.items():
            if sid in s["bound"]:
                # Unicast to the session owner, like global-shortcuts.c.
                conn.emit_signal(s["owner"], PORTAL_PATH, "org.freedesktop.portal.GlobalShortcuts",
                                 "Activated", GLib.Variant("(osta{sv})", (p, sid, 0, {})))
        inv.return_value(None)


def on_name_owner_changed(conn, sender, path, iface, signal, params):
    name, old, new = params.unpack()
    if name.startswith(":") and old and not new:
        for p in [p for p, s in sessions.items() if s["owner"] == name]:
            close_session(conn, p, "owner disconnected")


def on_bus(conn, name):
    conn.register_object(PORTAL_PATH, node.interfaces[0], on_portal_call, on_portal_get, None)
    conn.register_object("/test", test_node.interfaces[0], on_test_call, None, None)
    conn.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
                          "/org/freedesktop/DBus", None, Gio.DBusSignalFlags.NONE,
                          on_name_owner_changed)


def on_name(conn, name):
    print("READY", flush=True)


Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
                 on_bus, on_name, lambda c, n: sys.exit("could not own " + n))
GLib.MainLoop().run()
