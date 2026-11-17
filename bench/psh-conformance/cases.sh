#quoting
echo 'single $HOME "x"'
echo "double $((1+2)) 'y'"
echo "a\$b" 'c\d' e\ f
echo $'tab\there\nnl'
x='a  b'; echo $x; echo "$x"
x="*"; echo "$x"
echo "nested $(echo "inner $(echo deep)")"
echo \"escaped\" \\ \$
printf '%s\n' "a b" c 'd e'
echo ''"" | od -c | head -1
v=hello; echo "${v}world" "$v"_x
echo "\t not tab"
echo -e 'a\tb\\n'
echo -n abc; echo def
echo -- -n
IFS=:; x=a:b:c; for i in $x; do echo $i; done
set -- "a b" c; for i in "$@"; do echo "[$i]"; done
set -- "a b" c; for i in "$*"; do echo "[$i]"; done
set -- "a b" c; for i in $@; do echo "[$i]"; done
a="x y"; b=($a); echo ${#b[@]}
echo "$(printf 'a\n\n\n')|"
echo ~ | sed 's|/.*|/|'
#expansions
v=hello; echo ${#v}
v=hello; echo ${v:1:3} ${v: -2} ${v:2}
v=path/to/file.tar.gz; echo ${v##*/} ${v#*/} ${v%%.*} ${v%.*}
v=aaa; echo ${v/a/b} ${v//a/b} ${v/#a/c} ${v/%a/d}
unset u; echo ${u:-def} ${u-def2} "${u:+alt}" x
u=; echo "[${u:-def}]" "[${u-def}]" "[${u:+alt}]"
v=set; echo ${v:+alt} ${v:-def}
unset u; echo ${u:=assigned}; echo $u
v=Hello; echo ${v^^} ${v,,} ${v^} ${v,}
arr=(one two three); echo ${arr[@]:1} ${#arr[1]}
echo {a,b,c}{1,2}
echo {1..5} {5..1} {a..e}
echo {01..03} {1..10..3}
echo pre{x,y}post
echo $((10/3)) $((10%3)) $((2**10)) $((-7/2))
echo $(( (1+2)*3 )) $((1<2)) $((1==1&&0)) $((5>3?7:8))
i=5; ((i++)); echo $i; ((i+=10)); echo $i
i=0; echo $((i++)) $((++i)) $i
echo $((0x1f)) $((8#17)) $((2#101))
echo $(( 1 << 4 )) $(( 255 & 15 )) $(( 1 | 6 )) $(( 5 ^ 3 ))
x=3; y=4; echo $((x*y)) $((x>y)) $((x!=y))
let a=5+3; echo $a
echo $[2+3]
echo "$(( 7 / 2 )).$(( 7 % 2 ))"
n=010; echo $((10#$n))
name=VAR; declare "$name=val"; echo $VAR
x=abc; y=x; echo ${!y}
pre_a=1 pre_b=2; echo ${!pre_@}
v="a-b-c"; echo ${v//-/ }
f=/a/b/c.txt; echo $(basename $f) $(dirname $f) $(basename $f .txt)
echo $(echo a; echo b)
echo \`echo backtick\`
echo `echo backtick`
x=5; echo $((x+=2)) $x
s="hello world"; echo ${s/world/there}
echo ${#}
set -- a b c; echo $# $1 $3 ${@: -1}
set -- a b c; shift; echo $@
set -- a b c d e f g h i j k; echo ${10} ${11}
f() { echo $#; }; f "" "" x
echo "$((1+2))" "$[1+2]"
#globs
echo *.txt
echo dir/*
echo dir/*.txt
echo nomatch*
shopt -s nullglob; echo nomatch* end
echo [ab]*.txt
echo ?.txt
echo dir/**/*.md
shopt -s globstar; echo dir/**/*.md
echo d*r
for f in *.txt; do echo "f:$f"; done
case abc in a*) echo yes;; *) echo no;; esac
case x.md in *.txt) echo t;; *.md|*.rst) echo m;; esac
case 5 in [0-9]) echo digit;; esac
[[ abc == a* ]] && echo match
[[ abc =~ ^a(b)c$ ]] && echo ${BASH_REMATCH[1]}
[[ foo.txt == *.@(txt|md) ]] && echo ext
shopt -s extglob; ls !(*.txt) | head -3
#pipelines
echo hi | cat | cat
printf 'b\na\nc\n' | sort | head -2
false | true; echo $?
true | false; echo $?
set -o pipefail; false | true; echo $?
set -o pipefail; true | false | true; echo $?
echo a | { read x; echo got $x; }
echo a b c | while read x y; do echo "$y|$x"; done
x=1; echo 2 | read x; echo $x
cat a.txt | grep an | wc -l
echo hi |& cat
! true; echo $?
! false; echo $?
true && echo and; false || echo or
false && echo no; echo $?
true || echo no; echo ok
{ echo a; echo b; } | wc -l
(echo sub; exit 3); echo $?
x=1; (x=2); echo $x
x=1; { x=2; }; echo $x
echo $(exit 4); echo $?
seq 3 | tac
yes | head -3
seq 1 10 | paste -sd+ | bc
printf '%s\n' 3 1 2 | sort -n | tail -1
#redirects
echo hi > o.txt; cat o.txt
echo a > o.txt; echo b >> o.txt; cat o.txt
echo err >&2 2>/dev/null; echo after
{ echo out; echo err >&2; } 2>/dev/null
{ echo out; echo err >&2; } 2>&1 | wc -l
{ echo out; echo err >&2; } > o.txt 2>&1; cat o.txt
ls nonexist 2>/dev/null; echo $?
cat < a.txt | head -1
wc -l < a.txt
echo x &> o.txt; cat o.txt
echo x 1>&2 2>o.txt; cat o.txt
exec 3> o.txt; echo three >&3; exec 3>&-; cat o.txt
cat <<< "here string"
read a b <<< "1 2"; echo $b $a
echo data > o.txt; while read l; do echo "<$l>"; done < o.txt
: > o.txt; wc -c < o.txt
echo hi > /dev/null; echo $?
cat a.txt nonexist 2>&1 >/dev/null | wc -l
echo a >o.txt; echo b >| o.txt; cat o.txt
set -C; echo a > o.txt; echo b > o.txt; echo $?
#heredocs
<<<
cat <<EOF
line $((1+1))
EOF
>>>
<<<
cat <<'EOF'
no $expansion
EOF
>>>
<<<
cat <<-EOF
	tabbed
	EOF
>>>
<<<
x=v; cat <<EOF | tr a-z A-Z
val $x
EOF
>>>
<<<
cat <<EOF
a \$x \\ b
EOF
>>>
<<<
cat <<A; cat <<B
first
A
second
B
>>>
<<<
f() { cat; }; f <<EOF
fn heredoc
EOF
>>>
<<<
while read l; do echo "[$l]"; done <<EOF
1
2
EOF
>>>
<<<
cat <<"EOF"
quoted $x
EOF
>>>
<<<
x=$(cat <<EOF
heredoc in subst
EOF
); echo "$x"
>>>
#functions
f() { echo "args: $*"; }; f 1 2 3
f() { return 3; }; f; echo $?
f() { local x=inner; echo $x; }; x=outer; f; echo $x
f() { x=changed; }; x=orig; f; echo $x
function g { echo kw; }; g
f() { echo $1; shift; echo $1; }; f a b
fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }; fact 5
f() { echo ${FUNCNAME[0]}; }; f
f() { echo "$@" | wc -w; }; f a "b c" d
f() { :; }; type f | head -1
f() { echo in; }; unset -f f; f 2>/dev/null; echo $?
f() { local -a a=(1 2 3); echo ${#a[@]}; }; f
f() { declare -g G=global; }; f; echo $G
count() { echo $#; }; count "$@"; set -- a b; count "$@"
outer() { inner() { echo inner; }; inner; }; outer
f() { return; }; f; echo $?
f() { false; }; f && echo t || echo f
<<<
shopt -s expand_aliases
alias ll='echo aliased'
ll
>>>
#arrays
a=(x y z); echo ${a[0]} ${a[2]} ${#a[@]}
a=(x y z); a+=(w); echo ${a[@]}
a=(x y z); unset 'a[1]'; echo ${a[@]} ${#a[@]}
a=(x y z); echo ${!a[@]}
a=(); a[5]=five; echo ${!a[@]} ${a[5]}
a=(x y z); for e in "${a[@]}"; do echo $e; done
a=("a b" c); echo ${#a[@]}; printf '[%s]\n' "${a[@]}"
declare -A m; m[k1]=v1; m[k2]=v2; echo ${m[k1]} ${m[k2]}
declare -A m=([a]=1 [b]=2); for k in $(echo ${!m[@]} | tr ' ' '\n' | sort); do echo $k=${m[$k]}; done
declare -A m; m[x]=1; [[ -v m[x] ]] && echo has; [[ -v m[y] ]] || echo hasnt
a=(3 1 2); IFS=$'\n' s=($(sort <<<"${a[*]}")); echo ${s[@]}
a=(a b c); echo "${a[*]}"; IFS=,; echo "${a[*]}"
a=(1 2 3 4 5); echo ${a[@]:1:2}
read -a arr <<< "p q r"; echo ${arr[1]}
mapfile -t lines < a.txt; echo ${#lines[@]} ${lines[2]}
readarray -t L <<< $'1\n2'; echo ${L[1]}
a=(x y); a[1]+=z; echo ${a[1]}
a=(b a c); echo ${a[@]/a/A}
a=(1 2 3); echo $(( ${a[0]} + ${a[2]} ))
declare -a a=(1 2); declare -p a
declare -A m=([k]=v); echo ${#m[@]}
a=(x y z); echo ${a[-1]}
#arith
for ((i=0;i<3;i++)); do echo $i; done
i=0; while (( i < 3 )); do ((i++)); done; echo $i
(( 0 )); echo $?
(( 5 )); echo $?
x=$(( 3 > 2 )); echo $x
echo $(( 9223372036854775807 + 1 ))
echo $(( -5 % 3 ))
declare -i n=5; n+=3; echo $n
declare -i n; n="2*3"; echo $n
echo $((  1 ,  2 ))
a=3; echo $(( a++ + ++a )) $a
echo $(( ~5 )) $(( !0 ))
x=10; (( x > 5 )) && echo big
echo $(( 1/0 )) 2>&1 | head -1 | grep -c 'division'
#control
if true; then echo t; else echo f; fi
if false; then echo 1; elif true; then echo 2; else echo 3; fi
for i in 1 2 3; do [ $i = 2 ] && continue; echo $i; done
for i in 1 2 3; do [ $i = 2 ] && break; echo $i; done
for i in 1 2; do for j in a b; do [ $j = b ] && continue 2; echo $i$j; done; done
i=0; until [ $i -ge 2 ]; do echo $i; i=$((i+1)); done
set -- p q; for i; do echo $i; done
[ -f a.txt ] && echo file
[ -d dir ] && echo dir
[ -e nope ] || echo missing
[ -s a.txt ] && echo nonempty
[ -z "" ] && [ -n x ] && echo zn
[ 2 -lt 10 ] && [ 10 -gt 2 ] && [ 3 -eq 3 ] && echo num
[ abc \< abd ] && echo lt
[[ 2 < 10 ]] && echo strlt || echo strge
[[ -n $undefined ]] || echo emptyvar
[[ a && b ]] && echo both
test 1 -ne 2 && echo ne
[ ! -f nope ] && echo neg
[[ "a b" == "a b" ]] && echo eq
x=; [ -z "$x" ] && echo empty
case "" in "") echo emptycase;; esac
case foo in f??) echo three;; esac
while true; do echo once; break; done
for x in $(seq 3); do echo -n $x; done; echo
case b in a) echo a;& b) echo b;& c) echo c;; d) echo d;; esac
#set-e
set -e; false; echo not-reached
set -e; false || true; echo reached
set -e; if false; then :; fi; echo reached-if
set -e; f() { false; echo inf; }; f || echo caught
set -e; x=$(false); echo after-sub
set -e; false && true; echo after-and
set -e; (false); echo nope
set -u; echo $undefined_var; echo nope
set -u; echo ${undefined_var:-ok}
set -e; ! false; echo negok
set -eo pipefail; false | true; echo nope
set -e; trap 'echo trapped' EXIT; false
trap 'echo bye' EXIT; echo hi
trap 'echo err' ERR; false; echo cont
exit 7
f() { exit 2; }; f; echo no
set -e; for i in 1 2; do false; done; echo nope
set -e; while false; do :; done; echo ok-while
#builtins
printf '%5s|%-5s|%05d|%.2f|%x|%o\n' a b 42 3.14159 255 8
printf '%s,' a b c; echo
printf '%d%%\n' 50
printf '%c\n' hello
printf '%b\n' 'a\tb'
printf '%q\n' "a b'c"
printf -v var '%03d' 7; echo $var
printf '%s %s\n' 1 2 3
printf '%10.3s|\n' abcdef
printf '%e\n' 12345.678
printf '%i\n' 0x10
x=$(printf '%s' "no newline"); echo "[$x]"
read -r line <<< 'a\b'; echo "$line"
IFS=, read -r a b c <<< "1,2,3"; echo $c $a
echo "a b" | { read; echo "$REPLY"; }
type echo | head -1
command -v cat >/dev/null && echo has-cat
command -v nonexistent_cmd || echo none
pwd | sed 's|.*/||'
cd dir && pwd | sed 's|.*/||' && cd .. && pwd | sed 's|.*/||'
cd dir; cd sub; echo ${PWD##*/}; cd -  >/dev/null; echo ${PWD##*/}
pushd dir >/dev/null; echo ${PWD##*/}; popd >/dev/null; echo ${PWD##*/}
export FOO=bar; bash -c 'echo $FOO'
FOO=inline bash -c 'echo $FOO'; echo "[$FOO]"
bash -c 'exit 5'; echo $?
sh -c 'echo $0 $1' zero one
eval 'echo evaluated $((2*2))'
x='echo hi'; eval "$x"
source /dev/null; echo sourced
echo 'echo from-file $1' > s.sh; bash s.sh arg; . ./s.sh dot
getopts ab: opt -b val; echo $opt $OPTARG
set -- -a -b x; while getopts "ab:" o; do echo $o ${OPTARG:-}; done
unset x; x=1; unset x; echo ${x-unset}
readonly R=1; R=2 2>/dev/null; echo $R
true; echo $?; false; echo $?
echo $(( $(echo 3) + 4 ))
shopt -s nocasematch; [[ ABC == abc ]] && echo nocase
type -t cd; type -t ls; type -t if
declare -x E=1; env | grep -c '^E=1$'
wait; echo waited
sleep 0 & wait; echo bg
(echo async) & wait
printf '%s\n' "${HOME:+set}"
#coreutils
cat -n a.txt
head -n 2 a.txt; tail -n 1 a.txt
head -c 5 a.txt; echo
tail -n +2 a.txt
wc a.txt
wc -w words.txt; wc -c a.txt
sort -r a.txt
sort -n nums.txt
sort nums.txt
sort -t, -k2 -n data.csv
sort -u dup.txt
sort dup.txt | uniq -c
uniq -d dup.txt
uniq -u dup.txt
cut -d, -f1,3 data.csv
cut -c1-3 a.txt
cut -d, -f2- data.csv
tr 'a-z' 'A-Z' < a.txt
tr -d 'aeiou' < a.txt
echo baaad | tr -s 'a'
echo hello | tr -c 'l\n' x
paste -d: a.txt nums.txt
paste -s a.txt
nl a.txt
rev a.txt
tac a.txt
seq 5; seq 2 2 8; seq -s, 3
seq -w 8 10
fold -w 3 <<< abcdefgh
expand <<< $'a\tb' | od -c | head -1
comm -12 <(sort a.txt) <(printf 'banana\ncherry\nzz\n')
join <(printf '1 a\n2 b\n') <(printf '1 x\n2 y\n')
split -l 2 a.txt part_; ls part_*; cat part_ab
basename /x/y/z.sh .sh; dirname /x/y/z.sh
mkdir -p n/m/o && ls -d n/m/o
touch t1; ls t1; rm t1; ls t1 2>/dev/null || echo gone
cp a.txt b.txt; cat b.txt | wc -l
mv a.txt c.txt; ls c.txt; ls a.txt 2>/dev/null || echo moved
mkdir -p q; cp -r dir q/; find q | sort
ln -s a.txt lnk; cat lnk | head -1; readlink lnk
rm -rf dir; ls dir 2>/dev/null || echo removed
ls
ls -1 dir
ls -a dir
ls -R dir
stat -c %s a.txt
test -x a.txt || echo notexec; chmod +x a.txt; test -x a.txt && echo exec
md5sum a.txt
sha256sum a.txt
sha1sum a.txt
echo -n abc | base64; echo YWJj | base64 -d; echo
od -An -tx1 <<< ab
xxd <<< hi
printf 'a\nb\n' | tee t.txt | wc -l; cat t.txt
echo 'a b c' | xargs -n1
echo 'a b c' | xargs -n2 echo X
printf '1\n2\n' | xargs -I{} echo item-{}
find dir -name '*.txt' | sort | xargs cat
printf 'x\0y\0' | xargs -0 echo
echo a.txt | xargs wc -l
expr 3 + 4; expr length hello; expr 10 \* 2
expr substr hello 2 3
echo $(( $(wc -l < a.txt) * 2 ))
date -d @0 -u +%Y-%m-%d
date -u -d '2024-01-02 03:04:05' '+%H:%M'
env -i FOO=1 bash -c 'echo $FOO'
which ls >/dev/null && echo which-ok
numfmt --to=iec 2048
factor 12
seq 3 | shuf -n 3 | sort
truncate -s 2 a.txt; cat a.txt; echo
column -t <<< $'a b\nccc d'
diff <(echo a) <(echo b); echo $?
diff -u <(printf 'a\nb\n') <(printf 'a\nc\n') | tail -2
cmp a.txt a.txt && echo same
realpath -m /a/./b/../c
sleep 0.01; echo slept
timeout 1 sleep 0.01; echo $?
du -sb a.txt
sort -k2 words.txt
sort -t, -k3,3 -k2,2nr data.csv
head -n -1 a.txt
tail -c 4 a.txt
wc -L words.txt
printf '%s\n' 10 9 100 | sort -h
yes ab | head -c 7; echo
#grep
grep an a.txt
grep -c a a.txt
grep -v an a.txt
grep -i the words.txt
grep -n o words.txt
grep -o 'o[a-z]' words.txt
grep -w the words.txt
grep -E 'apple|cherry' a.txt
grep -F '.' data.csv | wc -l
grep -r x dir | sort
grep -rl x dir | sort
grep -l an a.txt words.txt
grep -h . a.txt | head -1
grep -A1 banana a.txt
grep -B1 banana a.txt
grep -C1 banana a.txt
grep -q apple a.txt && echo quiet
grep zzz a.txt; echo $?
grep -e apple -e cherry a.txt
grep '^b' a.txt; grep 'y$' a.txt
grep -P '\d+' data.csv | head -1
grep -m1 a a.txt
grep -x apple a.txt
grep -E '[0-9]{2}' data.csv
grep -c '' a.txt
grep 'a\|c' a.txt
grep -E '(an){2}' a.txt
grep --include='*.md' -r y dir
echo 'a.b' | grep -F 'a.b'
grep -ow '[a-z]*' <<< 'x1 yy z'
grep -rn x dir | sort
grep -H an a.txt
grep -s x nonexist; echo $?
grep -iv A a.txt
grep -E '^(a|b)' a.txt
grep '[[:upper:]]' words.txt
#sed
sed 's/a/A/' a.txt
sed 's/a/A/g' a.txt
sed -n '2p' a.txt
sed '2d' a.txt
sed -n '/an/p' a.txt
sed '1i\header' a.txt
sed '$a\footer' a.txt
sed -e 's/a/1/' -e 's/b/2/' a.txt
sed 's/\(a\)\(n\)/\2\1/g' a.txt
sed -E 's/(a)(n)/\2\1/' a.txt
sed 's|/|_|g' <<< /a/b
sed -n '1,2p' a.txt
sed '1~2d' a.txt
sed 'y/abc/xyz/' a.txt
sed = a.txt
sed -n '$=' a.txt
sed 's/.*/[&]/' a.txt
sed '/banana/,$d' a.txt
cp a.txt e.txt; sed -i 's/apple/APPLE/' e.txt; cat e.txt
sed 's/a/X/2' <<< banana
sed 's/[aeiou]//g; s/$/!/' a.txt
sed -n 'h;n;G;p' a.txt
sed '$!N;s/\n/ /' a.txt
sed 'N;P;D' a.txt
sed 's/x*/-/g' <<< abc
sed -E 's/^(.)(.*)$/\U\1\E\2/' a.txt
sed '/^$/d' <<< $'a\n\nb'
sed 'c\changed' <<< x
sed -n '/apple/{s/apple/fruit/;p}' a.txt
sed 's/a/b/w out.txt' a.txt >/dev/null; cat out.txt
sed '2q' a.txt
sed -s -n '1p' a.txt words.txt
sed -n '/apple/,/banana/p' a.txt
sed 's/a/&&/g' <<< ab
sed '0,/a/s//X/' a.txt
sed -E 's/[0-9]+/<&>/g' data.csv
sed '1!G;h;$!d' a.txt
sed 's/\s\+/ /g' <<< 'a    b'
#awk
awk '{print $1}' words.txt
awk -F, '{print $2}' data.csv
awk -F, 'NR>1 {s+=$2} END {print s}' data.csv
awk '{print NR": "$0}' a.txt
awk 'END{print NR}' a.txt
awk '{print NF}' words.txt
awk '{print $NF}' words.txt
awk 'length($0)>5' a.txt
awk '/an/{c++} END{print c}' a.txt
awk -F, '$3=="NYC"{print $1}' data.csv
awk 'BEGIN{printf "%5.2f|%-4s|%d\n", 3.14159, "ab", 42}'
awk 'BEGIN{x["a"]=1;x["b"]=2; n=0; for(k in x) n++; print n}'
awk '{a[$0]++} END{for(k in a) print k, a[k]}' dup.txt | sort
awk 'BEGIN{print length("hello"), substr("hello",2,3), index("hello","l")}'
awk 'BEGIN{s="a,b,c"; n=split(s,arr,","); print n, arr[3]}'
awk 'BEGIN{s="hello"; gsub(/l/,"L",s); print s}'
awk 'BEGIN{s="hello"; sub(/l/,"L",s); print s}'
awk 'BEGIN{print toupper("ab") tolower("CD")}'
awk 'BEGIN{print 1/3}'
awk 'BEGIN{print 2^10, 7%3, int(3.9)}'
awk 'BEGIN{OFS="-"} {$1=$1; print}' words.txt
awk -v x=5 'BEGIN{print x*2}'
awk 'NR==2{next} {print}' a.txt
awk '{printf "%s ", $1} END{print ""}' a.txt
awk 'BEGIN{while(i<3){i++; print i}}'
awk 'BEGIN{if (match("foobar", /ob/)) print RSTART, RLENGTH}'
awk '{print > ("aw_" NR ".txt")}' a.txt; cat aw_2.txt
awk 'BEGIN{"echo cmd" | getline x; print x}'
awk 'BEGIN{print sprintf("%03d", 7)}'
awk -F: '{print $1}' <<< 'a:b:c'
awk 'BEGIN{RS=""}{print NR": "$1}' <<< $'a\nb\n\nc'
awk '{ $2 = "X"; print }' words.txt
awk 'BEGIN { print substr("hello", 0, 2) }'
awk 'BEGIN { x = "10"; y = 9; print (x > y) }'
awk 'BEGIN { print 1e6, 0.1+0.2, 100000000 }'
awk 'function f(a){return a*2} BEGIN{print f(21)}'
awk '{s=s $0} END{print s}' a.txt
awk 'NR%2' a.txt
awk '$1 ~ /^b/' a.txt
awk 'BEGIN{print -3 % 2, 3 - -2}'
awk 'BEGIN{printf "%c%c\n", 65, "hello"}'
awk '{print FILENAME; exit}' a.txt
awk 'BEGIN{n=split("",a); print n}'
seq 5 | awk '{s+=$1} END {print s/NR}'
awk 'BEGIN{x="a b"; print x " c"}'
awk -F, 'NR>1{a[$3]+=$2} END{for(k in a) print k, a[k]}' data.csv | sort
awk '{print length}' a.txt
awk 'BEGIN { printf "%s\n", 0.000001 }'
awk 'BEGIN { print 123456789012 }'
awk '{ print $(NF-1) }' words.txt
awk 'BEGIN{FS=","} NR==1{for(i=1;i<=NF;i++) print i, $i}' data.csv
awk 'BEGIN{print substr("abc", 2)}'
awk '{getline; print}' a.txt
#jq
jq . j.json
jq -c . j.json
jq .a j.json
jq '.b[1]' j.json
jq '.b | length' j.json
jq -r '.c.d' j.json
jq '.items[] | .n' j.json
jq -r '.items[] | "\(.n)=\(.v)"' j.json
jq '[.items[] | .v] | add' j.json
jq '.items | map(select(.v > 1))' j.json
jq 'keys' j.json
jq -c 'to_entries[0]' j.json
jq '.b | map(. * 2)' j.json
jq -n '1 + 2'
jq -n '[1,2,3] | max'
jq -c '.items | sort_by(-.v)' j.json
jq -c '.items | group_by(.v > 1) | map(length)' j.json
jq 'has("a")' j.json
jq -r '.b | join(",")' j.json
jq -c '{x: .a, y: .c.d}' j.json
jq '.missing // "default"' j.json
jq -n '"abc" | ascii_upcase'
jq -c -n '"a,b" | split(",")'
jq -c 'del(.b)' j.json
jq -c '.a = 5 | .a' j.json
jq -c -n '[range(3)]'
jq -r '@base64 "\(.c.d)"' j.json
jq -n --arg x hi '$x'
jq -n --argjson x '{"a":1}' '$x.a'
jq -c 'paths' <<< '{"a":{"b":1}}'
jq -e '.nope' j.json; echo $?
jq -r '.items[] | [.n, .v] | @tsv' j.json
jq -r '.items[] | [.n, .v] | @csv' j.json
jq -s 'add' <<< '1 2 3'
jq -c 'reduce .b[] as $x (0; . + $x)' j.json
jq -n 'if 1 > 2 then "a" else "b" end'
jq -c '[.b[] | select(. % 2 == 1)]' j.json
jq -n '"x" * 3'
jq -c 'with_entries(.value |= tostring)' <<< '{"a":1}'
jq -n '1, 2 | . * 10'
jq '.b | first, last' j.json
jq -c 'tostream' <<< '[1]'
jq -n 'now | type'
jq -c '[.. | numbers]' j.json
jq -n '"test" | test("es")'
jq -rn '"a-b" | sub("-"; "+")'
jq -c 'unique' <<< '[2,1,2]'
jq '.a, .c' j.json
jq -r 'keys[]' j.json
jq -n '3.0, 1.5, 1e100'
jq -c '.items | map({(.n): .v}) | add' j.json
jq -n '[1,[2,[3]]] | flatten' -c
jq -r '.items | length' j.json
jq --tab .c j.json
jq -n 'null | not'
jq -c 'to_entries | map(.key)' <<< '{"b":1,"a":2}'
jq -S -c . <<< '{"b":1,"a":2}'
jq -n '"\u00e9" | length'
jq -r '.items[] | select(.n == "b") | .v' j.json
jq 'limit(2; .b[])' j.json
jq -c 'splits(", ")' <<< '"a, b"'
jq -c 'any, all' <<< '[true,false]'
#find
find dir | sort
find dir -type f | sort
find dir -type d | sort
find dir -name '*.md'
find . -maxdepth 1 -name '*.txt' | sort
find dir -name '*.txt' -exec cat {} \; | sort
find dir -name '*.txt' -exec echo {} + | tr ' ' '\n' | sort
find dir -path '*sub*' | sort
find dir -iname 'X.TXT'
find dir -size -1k -type f | sort
find dir -not -name '*.txt' -type f
find dir \( -name x.txt -o -name y.md \) | sort
find dir -mindepth 2
find . -name nomatch; echo $?
find dir -type f -print0 | xargs -0 cat | wc -c
find dir -name '*.txt' -delete; find dir | sort
find dir -type f -name '*.txt' -printf '%f\n' | sort
find nope 2>/dev/null; echo $?
mkdir emptyd; find . -empty -type d
find dir -maxdepth 1 -type f | wc -l
#misc
x=$(seq 100 | wc -l); echo $x
for i in {1..3}; do echo $i; done | paste -sd,
false | true; echo "${PIPESTATUS[@]}"
echo $BASH_VERSION | grep -c '^5'
v=abc; [[ $v == "abc" ]] && echo quoted-eq
<<<
echo 'multi
line'
>>>
<<<
echo a\
b
>>>
echo $(( $(seq 1 5 | paste -sd+) ))
cat a.txt | sort | uniq | wc -l
[[ -z $(ls nomatch* 2>/dev/null) ]] && echo nofiles
s=""; for w in a b c; do s+=$w; done; echo $s
IFS= read -r x <<< "  leading"; echo "[$x]"
read x <<< "  leading"; echo "[$x]"
echo "a" "b" > o.txt; cat -A o.txt
printf 'a\r\n' | od -c | head -1
echo "ünïcödé" | wc -c
echo "ünïcödé" | wc -m
v=ünï; echo ${#v}
LC_ALL=C sort <<< $'b\nB\na\nA'
echo {a..c} | tr ' ' '\n' | sort -r | head -1
printf '%s\n' a b | sed -n '$p'
echo "$((16#ff))"
x=1; x+=1; echo $x
declare -l lower=ABC; echo $lower
declare -u upper=abc; echo $upper
cat /dev/null; echo $?
echo hi | cat - a.txt | head -2
printf '' | wc -l
echo $(< a.txt)
x=$(< a.txt); echo "${x//$'\n'/,}"
echo $((RANDOM >= 0))
nosuchcmd; echo $?
./a.txt; echo $?
echo "$(echo "a b")" | wc -w
f() { echo "$1"; }; f "$(printf 'x\ny')"
arr=($(echo 1 2 3)); echo ${#arr[@]}
cat a.txt | while read -r l; do echo "${#l}"; done
echo abc > f1; [ f1 -nt nope ] && echo newer; echo ok
echo $(( $(date +%s) > 0 ))
echo "$((1+1))" > "n o.txt"; cat "n o.txt"; ls n*
