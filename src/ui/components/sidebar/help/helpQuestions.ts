import {
  ArchiveRestore,
  Bug,
  Database,
  DatabaseBackup,
  EyeOff,
  FileText,
  FileX2,
  Fingerprint,
  Globe,
  KeyRound,
  Lightbulb,
  LockKeyhole,
  Network,
  RadioTower,
  Search,
  Send,
  Server,
  ShieldCheck,
  UserRoundCheck,
  Users,
  UserSearch,
  type LucideIcon,
} from 'lucide-react';

export type HelpQuestion = {
  id: string;
  category: string;
  question: string;
  summary: string;
  answer: string[];
  icon: LucideIcon;
};

export const HELP_QUESTIONS: HelpQuestion[] = [
  {
    id: 'how-it-works',
    category: 'Overview',
    question: 'How does Kiyeovo work?',
    summary: 'Kiyeovo is peer-to-peer: your app talks to other apps directly, instead of routing everything through one company\'s server.',
    answer: [
      'Quick tour. Each piece below has its own question if you want to dig in.',
      'Kiyeovo is a peer-to-peer messenger. Your device runs a network node and tries to talk straight to the people you\'re chatting with, instead of handing everything to a company in the middle.',
      'The DHT (Distributed Hash Table) is the shared phone book. Every node keeps a slice of it, and together they let peers look up things like usernames, where to reach someone, and messages delivered to a user while the user is offline - no central server required.',
      'Bootstrap, relay, and STUN/TURN servers are the supporting cast. Bootstrap introduces you to the network, relays help two peers reach each other outside of their local networks, and STUN/TURN help calls find a working path. None of them are "the chat server" - they help you find and reach each other without becoming a central account or message-storage server.',
      'The whole point is that separation: infrastructure handles introductions, but your actual messages are secured by Kiyeovo before they ever leave your device.',
    ],
    icon: Network,
  },
  {
    id: 'dual-network-mode',
    category: 'Overview',
    question: 'Why are there two network modes? What is the difference?',
    summary: 'Fast mode is the everyday driver and the only one with calls. Anonymous mode trades speed for Tor-routed privacy.',
    answer: [
      'No single network is good at everything, so Kiyeovo ships two and lets you pick.',
      'Fast mode is the daily driver: regular peer-to-peer networking over the clearnet, relay support, low latency - and it\'s the only mode where calls make sense.',
      'Anonymous mode routes everything through Tor. Slower, fussier, but built for people who care more about hiding where they\'re connecting from than about speed or calls.',
      'The two are deliberately walled off from each other - their setup, network records, and infrastructure don\'t mix. That\'s also why switching modes needs a restart: the app has to come back up cleanly in the other network.',
    ],
    icon: Network,
  },
  {
    id: 'anonymous-mode',
    category: 'Privacy',
    question: 'What is anonymous mode, and how anonymous is it really?',
    summary: 'It routes Kiyeovo through Tor. Great for hiding your network location - not a one-click cloak of invisibility.',
    answer: [
      'Anonymous mode is Kiyeovo running over Tor. It shrinks what ordinary network observers and clearnet infrastructure can learn about where you\'re connecting from.',
      'Be careful. Your username, the things you tell people, your timing patterns, whatever you share in chat - all of that can still point back at you. Tor hides the pipe, not your behavior.',
      'To switch: Settings, then the network-mode switch, then restart when asked. You\'ll also need an anonymous-mode (onion) bootstrap address - the installed app already bundles the Tor setup it needs on the client side.',
    ],
    icon: EyeOff,
  },
  {
    id: 'bootstrap',
    category: 'Setup',
    question: 'Why do I need bootstrap servers?',
    summary: 'Bootstrap servers introduce you to the network. They are the doorman, not the place your chats live.',
    answer: [
      'A client is standing at the door with no idea who\'s inside. It needs a few known addresses to ask "hey, where is everyone?"',
      'That\'s bootstrap. These servers are the introduction - they help you discover peers and learn the lay of the network.',
      'Once you have been introduced, contact, messaging, and the rest run over the peer-to-peer network, not through bootstrap. Think doorman, not destination.',
    ],
    icon: Network,
  },
  {
    id: 'relay-servers',
    category: 'Network',
    question: 'What are relay servers?',
    summary: 'Relays help two peers connect when routers and firewalls get in the way. They move your encrypted traffic; they can\'t read it.',
    answer: [
      'In a tidy peer-to-peer world, you would connect straight to every contact. Real networks are a mess of home routers, mobile carriers, NAT, and firewalls that love to block direct connections.',
      'A relay is the workaround. In fast mode, Kiyeovo can reserve relay connectivity so your traffic has a chance of reaching the other peer.',
      'Worth being clear: a relay is not a chat server and shouldn\'t be able to read your message content - that part is encrypted. It can still see metadata like timing and network addresses, which is just the nature of relaying.',
      'Anonymous mode skips this layer entirely; Tor already handles routing its own way.',
    ],
    icon: RadioTower,
  },
  {
    id: 'stun-turn-servers',
    category: 'Calls',
    question: 'What are STUN and TURN servers?',
    summary: 'Call-only helpers. WebRTC uses them to find a working voice and video path through your network.',
    answer: [
      'Calls are a different beast from text. Voice and video need a steady live path between two devices, and that path usually has to punch through routers and firewalls.',
      'A STUN server tells your app how it looks from the outside world. Often that\'s enough to set up a direct call.',
      'A TURN server is the heavier fallback: when devices genuinely can\'t reach each other directly, TURN relays the call traffic between them. That\'s the thing that rescues calls on strict networks - and also why it costs more to run.',
      'This is purely call-related. It is separate from bootstrap, messaging relays, and the DHT.',
    ],
    icon: Server,
  },
  {
    id: 'discover-users',
    category: 'Network',
    question: 'How can I find other users if there is no central server?',
    summary: 'Public discovery rides the DHT. Prefer privacy? Hand someone a trusted profile instead.',
    answer: [
      'Register a username and Kiyeovo publishes a signed discovery record to the DHT. Anyone can look that name up and get what they need to send you a contact request - no central account server handing out the address book. The username is republished while you\'re online, but after some time offline, your username is no longer "reserved" for you and someone else can register it.',
      'Validators along the way check that records are well-formed, so the network rejects garbage instead of trusting whatever shows up.',
      'Don\'t want to be searchable at all? Skip the username and share a trusted profile out-of-band. Same result - they can reach you - without ever putting your name on the public board. Just go to the Profile tab and select "Export trusted profile."',
    ],
    icon: Search,
  },
  {
    id: 'public-discoverability',
    category: 'Identity',
    question: 'If I register a username, am I publicly discoverable?',
    summary: 'Technically reachable, yes - but there is no directory to browse. People can only reach a username they already know or guess exactly.',
    answer: [
      'Sort of - but not the way "public" usually feels. There\'s no central database to browse and no search box that lists every user. Registering doesn\'t put you on a wall for strangers to scroll through.',
      'What registering actually does is make one exact username resolvable: if someone types your username letter-for-letter, the DHT can point them to you. So yes, anyone can reach you - but only if they already know the name to type. There\'s no "show me everyone" button, because no single server holds the full list.',
      'Register something obvious like "john" (hello, John) and people will guess it. Register something nobody would ever type - say, "potass1um_w4rlord_010437" - and you\'re effectively unlisted: reachable in theory, unfindable in practice.',
      'The other way for people to discover you is through your peer ID, which is also registered with your username. But don\'t worry: it is too long and random to guess realistically (you can find your peer ID in the Profile tab).',
    ],
    icon: Globe,
  },
  {
    id: 'registration',
    category: 'Identity',
    question: 'Do I have to register a username?',
    summary: 'Not to chat. Only if you want people to find you by name on the DHT.',
    answer: [
      'Register if you want to be searchable. Your username becomes a public handle - basically "this name points to this Kiyeovo identity" - and people can look it up to start a contact request. Also, keep in mind that the username is stored in (and refreshed on) the DHT only while you\'re online. After some time offline, your username is no longer "reserved" for you and someone else can register it.',
      'Skip it if you\'d rather keep things deliberate. A trusted profile hands someone everything they need to reach you, no public name involved.',
      'So it really comes down to discoverability. Public username: easy to find. Trusted profile: quieter and more intentional.',
    ],
    icon: UserRoundCheck,
  },
  {
    id: 'peer-id',
    category: 'Identity',
    question: 'What is a peer ID?',
    summary: 'Your identity\'s real address on the network - a long, unique string. The username is just a friendly label pointing at it.',
    answer: [
      'Every Kiyeovo identity has a peer ID: a long, unique string generated from your identity keys. It\'s your true address on the network - the thing peers actually use to find and connect to you under the hood.',
      'A username is just a friendly label sitting on top of that. When someone looks up your name on the DHT, what they really get back is the route to your peer ID.',
      'You can find yours in the Profile tab. One catch worth knowing: simply having a peer ID doesn\'t make you reachable. People can only look it up on the network if you\'ve registered (see the next question). It\'s long and unmemorable by design - built to be unique, not pretty.',
    ],
    icon: Fingerprint,
  },
  {
    id: 'find-by-peer-id',
    category: 'Identity',
    question: 'Can I reach someone with their peer ID instead of a username?',
    summary: 'Only if they have registered. Registering also publishes a record under their peer ID, so it is a second handle for the same identity.',
    answer: [
      'Yes - but only for people who have registered. When you register a username, Kiyeovo also publishes a second DHT record under your peer ID. So your name and your peer ID become two handles pointing at the same identity, and either one lets someone start a chat.',
      'For someone who never registered, a bare peer ID gets you nowhere. There\'s no record on the network to resolve it to, so "New conversation" just comes up empty. The peer ID is real - it\'s just unlisted.',
      'So how do you reach an unregistered person? You can ask them to register, or use the trusted profile feature. It gives the other person your signed public identity details out-of-band instead of relying on a DHT lookup - which is exactly why it works when a plain peer ID doesn\'t.',
    ],
    icon: UserSearch,
  },
  {
    id: 'trusted-users',
    category: 'Identity',
    question: 'What does "trusted profile" mean?',
    summary: 'A contact card you hand someone through a channel you already trust - no public search involved.',
    answer: [
      'A trusted profile is you saying "this is my Kiyeovo identity, and I\'m giving it to you on purpose." It\'s a small file with everything that another client needs to start a chat with you.',
      'Share it somewhere you can actually confirm who\'s on the other end - in person, on a call, through a channel you trust. That confirmation is the whole feature: the contact comes from a real relationship, not a search result or a random inbound ping.',
      'Once they import it, they can message you directly with no username lookup. However, you also have to import the other person. Why? Well, imagine that anyone with your ".kiyeovo" user file could message you - if your file were leaked, anyone could contact and spam you.',
      'Handy when you don\'t want a public username, or when you want one specific person to skip discovery entirely.',
    ],
    icon: ShieldCheck,
  },
  {
    id: 'trusted-not-forever',
    category: 'Identity',
    question: 'Does "trusted" mean I trust that person forever?',
    summary: 'Nope. "Trusted" describes how the contact was added - not a permanent seal of approval.',
    answer: [
      '"Trusted" is about the beginning of the relationship, not a lifetime guarantee. It means this contact arrived through an intentional exchange instead of a public search or a cold inbound request.',
      'It does not mean the person is safe forever, or auto-approved for everything they might do later. People change; trust is yours to manage.',
      'Treat the chat like any other. You can remove them, block them, or just be thoughtful about what you send.',
    ],
    icon: ShieldCheck,
  },
  {
    id: 'password-recovery',
    category: 'Identity',
    question: 'What if I forget my password? What is the recovery phrase for?',
    summary: 'Your password locks your identity; the recovery phrase is your backup key. Lose both and there is no reset button.',
    answer: [
      'Your Kiyeovo identity is encrypted on your device with your password. No company is holding a master copy - which is exactly what you want for privacy, and exactly why nobody can email you a reset link if you forget it.',
      'That\'s what the recovery phrase is for. Write it down when you set up your identity and keep it somewhere safe and offline; it\'s the backup key to getting back in. I recommend writing it on a piece of paper.',
      'Repeated wrong guesses trigger a cooldown on purpose, slowing anyone with physical access to your PC who tries to brute-force their way in. So the deal is simple: guard the password, guard the recovery phrase, and you OWN your account.',
    ],
    icon: KeyRound,
  },
  {
    id: 'groups',
    category: 'Groups',
    question: 'How do group chats work?',
    summary: 'Same peer-to-peer, encrypted foundation as 1:1 - with extra bookkeeping so everyone stays in sync.',
    answer: [
      'Groups run on the same peer-to-peer foundation as direct chats, just with more moving parts. Live messages travel over a shared group channel everyone\'s subscribed to, while membership and control updates get delivered more carefully behind the scenes - with acknowledgements and retries so nobody silently falls out of sync.',
      'Every membership change - someone joins, leaves, or gets kicked - rotates the group\'s encryption key. New members can read from the point they joined; they don\'t get a magic backlog of everything said before they showed up.',
      'Groups support file sharing, just like direct chats. One small difference in behavior: in a 1:1 chat, an over-long text message offers to convert itself into a .txt file automatically - in a group it doesn\'t, so you\'ll be asked to trim it down (you can always attach a file yourself).',
    ],
    icon: Users,
  },
  {
    id: 'message-states',
    category: 'Messaging',
    question: 'What do "sending", "offline", and "failed" mean on my messages?',
    summary: 'Each label tells you where your message is on its journey - and whether it still needs you.',
    answer: [
      'When you hit send, Kiyeovo first tries to reach the recipient live. If they\'re there, great - it\'s on its way.',
      'If they\'re not reachable, a text message can fall back to offline delivery: it gets encrypted and parked for them to pick up later. That\'s the "offline" state - not an error, just "waiting in the drop-box."',
      '"Failed" means none of the paths worked right now - the peer\'s unreachable, your outbox to them is full, or the network\'s still waking up. Retries are manual on purpose, so you stay in control: fix the situation, hit retry, done.',
      'File offers can use offline delivery, but the actual download waits until both people are online. Calls still need everyone online.',
    ],
    icon: Send,
  },
  {
    id: 'char-limit',
    category: 'Messaging',
    question: 'Why is there a message length limit?',
    summary: 'Text caps at 2,048 characters. In a 1:1 chat, going over offers to send it as a .txt file instead.',
    answer: [
      'Messages are capped at 2,048 characters. It keeps chat feeling like chat instead of turning the message channel into a document pipe.',
      'Paste something huge into a direct chat and Kiyeovo offers a graceful exit: ship it as a .txt file instead. The offer can arrive while the other person is offline; downloading waits until both of you are online.',
      'Groups don\'t get that automatic escape hatch - an over-long group message just asks you to trim it down. (Group file sharing does work; it just isn\'t offered as an auto-conversion, so attach the file yourself if you need to.)',
      'Why even have a limit? Well, imagine what the DHT and network would look like if one-million-character messages were allowed.',
    ],
    icon: FileText,
  },
  {
    id: 'offline-storage',
    category: 'Offline',
    question: 'What does offline delivery actually mean?',
    summary: 'An encrypted message can wait in a drop-box until the other app comes back for it.',
    answer: [
      'If the recipient is not online, the encrypted message is stored in their DHT bucket and fetched when they come online. It\'s sealed for that recipient.',
      'Picture a waiting room, not a cloud backup of your chats. It holds small encrypted payloads until the recipient\'s app returns and collects them.',
      'The real conversation lives in the apps themselves. Once the recipient fetches the message, Kiyeovo acknowledges it and the parked copy can be cleared out.',
    ],
    icon: Database,
  },
  {
    id: 'offline-files',
    category: 'Files',
    question: 'Can I send a file to someone who is offline?',
    summary: 'The file offer can wait for them, but the actual transfer needs you both online - the drop-box holds tiny messages, not your files.',
    answer: [
      'Partly, yes. The file offer itself can be delivered offline: it rides the same drop-box as text, so the recipient sees "wants to send you a file" when they next come online.',
      'The actual transfer only happens while you\'re both online. Holding a short text message for a few hours is cheap; parking your 200 MB video in the DHT is not - it would turn the offline drop-box into a file-hosting service, babysitting clips nobody fetches and inviting abuse. Hard pass.',
      'So the compromise: the offer waits, the transfer doesn\'t. Once you\'re both online, the download goes ahead. That keeps the offline layer small, fast, and tough to abuse.',
    ],
    icon: FileX2,
  },
  {
    id: 'message-troubleshooting',
    category: 'Troubleshooting',
    question: "Why do my messages sometimes fail to go through?",
    summary: 'Delivery needs either a live connection or a working offline fallback - here is what to check when neither happens.',
    answer: [
      'A message has a few routes. Kiyeovo tries the other app live first; if that misses, a text message can fall back to offline delivery.',
      'It stalls when the peer\'s unreachable, you\'re not connected to the DHT, relays are missing in fast mode, their offline inbox is full, or the network\'s still catching up after startup or sleep.',
      'Files and calls are stricter - they need everyone involved to be online and reachable - so they don\'t get the offline cushion at all.',
      'The fix is almost always upstream of the message: get Setup healthy (bootstrap, plus relays in fast mode), wait for the app to show a solid connection, then retry. Still doesn\'t work? Restart the app lol.',
    ],
    icon: Bug,
  },
  {
    id: 'register-troubleshooting',
    category: 'Troubleshooting',
    question: "Why doesn't my registration always go through?",
    summary: 'Registering writes a username to the DHT, so it leans on network reachability and the name being free.',
    answer: [
      'Registering isn\'t a local toggle - Kiyeovo has to publish a signed record so the network can find your name later. That means it depends on actually being connected.',
      'It can fail if you\'re not connected to the DHT, bootstrap is misconfigured, the network\'s still warming up after launch, or the username is already taken.',
      'Fast mode makes this feel random when bootstrap or DHT connectivity is shaky; anonymous mode is just slower because Tor and onion bootstrap take their time.',
      'If it won\'t go through: check Setup, give it a moment, and retry.',
    ],
    icon: Bug,
  },
  {
    id: 'security',
    category: 'Security',
    question: 'What makes this app secure?',
    summary: 'End-to-end encryption, signed network records, a locally encrypted identity, and a locked-down desktop shell.',
    answer: [
      'Direct messages are end-to-end encrypted after a key exchange, so the network helpers in the middle do not receive your plaintext content - they just move sealed envelopes.',
      'The important network records are signed and validated, which lets the app throw out malformed or unauthorized data instead of trusting whatever it finds out there.',
      'Your identity sits on your device, encrypted with your password. The desktop app is also hardened the boring-but-important way: context isolation, a sandboxed renderer, tight permissions, and a custom protocol for local media instead of handing the UI your whole filesystem.',
      'The honest caveat: security still rides on your device, your password, your recovery phrase, and who you choose to trust. Kiyeovo shrinks what infrastructure needs to know - it can\'t save a compromised computer or undo a bad habit.',
    ],
    icon: LockKeyhole,
  },
  {
    id: 'data-collection',
    category: 'Privacy',
    question: 'Do you collect any data?',
    summary: 'No central account or message server, and no analytics in this codebase. Infrastructure still sees the metadata it needs to function.',
    answer: [
      'The data that matters stays put: your identity, chats, settings, and history all live on your device.',
      'There\'s no central Kiyeovo server collecting your conversations, and this codebase ships no analytics or telemetry pipeline. Nobody\'s quietly counting your taps.',
      'The servers that help connect you - bootstrap, relays, TURN - do notice some things just by passing your traffic along: that your device showed up, roughly when, and what network address it came from. Think of a courier who can see the envelope and where it\'s going, but never opens it. What you actually wrote stays encrypted the whole way.',
      'Anonymous mode rewrites the metadata story by routing through Tor - but, again, it doesn\'t make everything you do anonymous on its own.',
    ],
    icon: ShieldCheck,
  },
  {
    id: 'backup-restore',
    category: 'Backup',
    question: 'Can I back up my data and use it on another PC?',
    summary: 'Yes - back up the database and import it elsewhere. The backup is not encrypted as a whole, and downloaded files are not included.',
    answer: [
      'Make a database backup from Settings. On another install, the login screen has an import-from-backup path that restores it and restarts the app.',
      'Treat that file like the crown jewels. The backup itself is not encrypted: chat history and other local data are readable by anyone who gets the file, although your identity keys inside it remain password-encrypted. Keep it in encrypted, private storage.',
      'A database backup isn\'t a copy of everything on disk. Downloaded files live outside the database, so if you want those too, copy them separately.',
      'And actually test a restore on a spare install before you ever need it for real. A backup you\'ve never opened is just a hopeful guess.',
    ],
    icon: DatabaseBackup,
  },
  {
    id: 'self-hosting',
    category: 'Setup',
    question: 'Can I run my own infrastructure?',
    summary: 'Yep. Bootstrap, relay, and STUN/TURN are all built to be self-hosted.',
    answer: [
      'Run your own bootstrap node and your app has an entry point into the network that you control.',
      'In fast mode, add a relay node to improve reachability for peers that can\'t connect directly.',
      'For calls, stand up STUN/TURN (coturn is the usual pick) and add the servers in Setup.',
      'The project README has a step-by-step guide (see "Bootstrap and relay setup") - the released kiyeovo-infra bundle spins up bootstrap, relay, and optional STUN/TURN with Docker. Self-hosting buys you control and costs you responsibility: uptime, firewall rules, updates, and protecting whatever your server logs.',
    ],
    icon: ArchiveRestore,
  },
  {
    id: 'feature-ideas-bugs',
    category: 'Feedback',
    question: 'How do I submit feature ideas and bug reports?',
    summary: 'GitHub issues - and give enough detail to actually reproduce it.',
    answer: [
      'Best spot is the Kiyeovo GitHub issues page: https://github.com/Realman78/Kiyeovo/issues',
      'For bugs, explain what you were doing, your network mode, what you expected, what actually happened, and which area it touched - direct chat, groups, files, calls, setup, registration, or offline delivery.',
      'If you can reproduce it, list the steps. Saw an error? Paste the exact text. For feature ideas, lead with the problem you\'re hitting - the solution is the easy part once we understand the "why."',
    ],
    icon: Lightbulb,
  },
];

export const normalizeHelpQuery = (value: string) => value.trim().toLowerCase();

export const helpQuestionMatches = (question: HelpQuestion, normalizedQuery: string) => {
  if (!normalizedQuery) return true;

  return [
    question.category,
    question.question,
    question.summary,
    ...question.answer,
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
};
