import Foundation

/// "Bionic" reading: the first part of every word in bold, so the eye has an anchor. Done in the page itself,
/// by a script the reader installs in each chapter's web view; switching it off puts the text back.
enum BionicReading {
    /// The script. `window.ptBionic(true | false)` turns it on or off for the page that has it, and
    /// `__ptBionicInitial` (set ahead of it) says which way a freshly loaded chapter starts.
    static func script(startOn: Bool) -> String {
        "window.__ptBionicInitial = \(startOn ? "true" : "false");\n" + body
    }

    /// Run on the page already showing, when the reader flips the switch.
    static func command(on: Bool) -> String {
        "window.ptBionic && window.ptBionic(\(on ? "true" : "false"));"
    }

    private static let body = #"""
    (function () {
      if (window.ptBionic) { return; }
      var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, SVG: 1, MATH: 1, TEXTAREA: 1 };
      function boldLength(n) { return n <= 2 ? 1 : Math.ceil(n * 0.4); }
      function wrap(node) {
        var text = node.nodeValue;
        if (!/\p{L}/u.test(text)) { return; }
        var frag = document.createDocumentFragment();
        var re = /(\p{L}[\p{L}\p{M}'’]*)|([^\p{L}]+)/gu;
        var m;
        while ((m = re.exec(text))) {
          if (m[1]) {
            var word = m[1], k = boldLength(word.length);
            var b = document.createElement('b');
            b.className = 'pt-bionic';
            b.textContent = word.slice(0, k);
            frag.appendChild(b);
            frag.appendChild(document.createTextNode(word.slice(k)));
          } else {
            frag.appendChild(document.createTextNode(m[2]));
          }
        }
        node.parentNode.replaceChild(frag, node);
      }
      function on() {
        if (!document.body) { return; }
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: function (n) {
            var p = n.parentNode;
            if (!p || SKIP[String(p.nodeName).toUpperCase()]) { return NodeFilter.FILTER_REJECT; }
            if (p.classList && p.classList.contains('pt-bionic')) { return NodeFilter.FILTER_REJECT; }
            return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        });
        var nodes = [];
        while (walker.nextNode()) { nodes.push(walker.currentNode); }
        // a chapter this large is left as it is: the page would stall
        if (nodes.length > 40000) { return; }
        nodes.forEach(wrap);
        document.documentElement.setAttribute('data-pt-bionic', '1');
      }
      function off() {
        var marks = document.querySelectorAll('b.pt-bionic');
        for (var i = 0; i < marks.length; i++) {
          var b = marks[i];
          b.parentNode.replaceChild(document.createTextNode(b.textContent), b);
        }
        if (document.body) { document.body.normalize(); }
        document.documentElement.removeAttribute('data-pt-bionic');
      }
      window.ptBionic = function (enabled) {
        var active = document.documentElement.hasAttribute('data-pt-bionic');
        if (enabled && !active) { on(); } else if (!enabled && active) { off(); }
      };
      if (window.__ptBionicInitial) { window.ptBionic(true); }
    })();
    """#
}
