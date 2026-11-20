# CompCue Link privacy

CompCue Link is a small program that connects the League of Legends client on your computer to your own account on
CompCue (https://compcue.aflince.com). This page says what it reads, what it sends and what it keeps. The program is
open source, so every statement here can be checked against the code in this repository.

Last updated: November 20, 2026.

## What it reads

Only the League client running on your own computer, and only by asking the client's own local interface. It can read
these things and nothing else (the list is fixed inside the program, in `src/shared/link.ts`):

- whether you are in a lobby, in champ select or in a game
- your lobby: who is in your party (their player ids)
- champ select: picks, bans, the timer, and the players the client itself shows you
- your own summoner name, region and language
- the champions you own and your champion mastery
- recent match history and ranked stats, for you and for players the client shows you

It never reads the game itself, the game's memory, your chat, your friends list, your password or your payment details.
It never reads other files on your computer. It cannot pick, ban, accept a match or click anything: it has no way to
write to the client. While a game is being played it sends nothing but the fact that a game is in progress.

## What it sends, and where

- **To CompCue** (the site address built into the program, over an encrypted connection): the items above, cut down to
  the fields the site uses. Chat tokens, game server addresses and similar fields that travel in the same client
  answers are removed on your computer before anything is sent. When you connect a computer it also sends that
  computer's name and whether it is Windows or Mac, so you can recognise it in your list of connected computers.
- **To GitHub**: a request for the newest version number, to know when an update exists. It carries no information
  about you beyond what any download request carries (your IP address).

It sends nothing to anyone else. It has no advertising, no analytics and no tracking.

## What it keeps on your computer

In one folder only your user can read: a token that identifies this computer to your CompCue account, a small status
file, and a short log of what it did (never the token). Uninstalling removes the program; on a Mac the uninstall
command also removes this folder.

## Your choices

- Remove a computer from the Connect page on CompCue: its token stops working at once.
- Quit CompCue Link from its menu at any time. Nothing is read or sent while it is not running.
- Uninstall it like any other app.

What CompCue does with a draft once it has received it (for example showing it to you and asking the coach for advice)
is described on the CompCue site.

## Riot Games

CompCue Link is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone
officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are
trademarks or registered trademarks of Riot Games, Inc.

## Contact

Questions or requests: hello@aflince.com
